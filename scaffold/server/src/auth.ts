import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from './config.js';
import { getRedis } from './redis.js';

const SESSION_COOKIE = 'switchboard_session';
const OIDC_STATE_COOKIE = 'switchboard_oidc_state';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});

const sessionSchema = z.object({
  sub: z.string().min(1),
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      role: z.enum(['admin', 'agent']),
    }),
  ),
  name: z.string().optional(),
  email: z.string().optional(),
});

export type UserSession = z.infer<typeof sessionSchema>;

let discoveryPromise: Promise<z.infer<typeof discoverySchema>> | undefined;
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function getDiscovery(): Promise<z.infer<typeof discoverySchema>> {
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const response = await fetch(
        `${config.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
      const discovery = discoverySchema.parse(await response.json());
      if (discovery.issuer !== config.oidc.issuer) {
        throw new Error('OIDC discovery issuer did not match OIDC_ISSUER');
      }
      remoteJwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
      return discovery;
    })().catch((error: unknown) => {
      discoveryPromise = undefined;
      throw error;
    });
  }
  return discoveryPromise;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  options: { maxAge: number; path: string; httpOnly: boolean },
): void {
  const secure = res.req.secure ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${options.maxAge}; SameSite=Lax${options.httpOnly ? '; HttpOnly' : ''}${secure}`,
  );
}

function clearCookie(res: Response, name: string, path: string): void {
  setCookie(res, name, '', { maxAge: 0, path, httpOnly: true });
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function beginLogin(_req: Request, res: Response): Promise<void> {
  const discovery = await getDiscovery();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await getRedis().set(
    `switchboard:oidc:${state}`,
    JSON.stringify({ nonce, verifier }),
    'EX',
    300,
  );
  setCookie(res, OIDC_STATE_COOKIE, state, {
    maxAge: 300,
    path: '/auth/callback',
    httpOnly: true,
  });

  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  res.redirect(302, authorizationUrl.toString());
}

export async function finishLogin(req: Request, res: Response): Promise<void> {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const stateCookie = cookieValue(req.headers.cookie, OIDC_STATE_COOKIE);
  if (!code || !state || !stateCookie || state !== stateCookie) {
    clearCookie(res, OIDC_STATE_COOKIE, '/auth/callback');
    res.status(400).json({ error: { code: 'OIDC_STATE_INVALID', message: 'Login state is invalid' } });
    return;
  }

  const redis = getRedis();
  const saved = await redis.getdel(`switchboard:oidc:${state}`);
  clearCookie(res, OIDC_STATE_COOKIE, '/auth/callback');
  if (!saved) {
    res.status(400).json({ error: { code: 'OIDC_STATE_EXPIRED', message: 'Login state expired' } });
    return;
  }
  const flow = z.object({ nonce: z.string(), verifier: z.string() }).parse(JSON.parse(saved));
  const discovery = await getDiscovery();
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: flow.verifier,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) {
    res.status(401).json({ error: { code: 'OIDC_CODE_REJECTED', message: 'Identity provider rejected login' } });
    return;
  }

  const tokens = z.object({ id_token: z.string().min(1) }).parse(await tokenResponse.json());
  if (!remoteJwks) throw new Error('OIDC signing keys are unavailable');
  const { payload } = await jwtVerify(tokens.id_token, remoteJwks, {
    issuer: config.oidc.issuer,
    audience: config.oidc.clientId,
  });
  if (payload.nonce !== flow.nonce) {
    res.status(401).json({ error: { code: 'OIDC_NONCE_INVALID', message: 'Identity token nonce did not match' } });
    return;
  }

  const session = sessionSchema.parse({
    sub: payload.sub,
    workspaces: payload.workspaces,
    name: payload.name,
    email: payload.email,
  });
  const sessionId = randomToken();
  await redis.set(
    `switchboard:session:${sessionId}`,
    JSON.stringify(session),
    'EX',
    SESSION_TTL_SECONDS,
  );
  setCookie(res, SESSION_COOKIE, sessionId, {
    maxAge: SESSION_TTL_SECONDS,
    path: '/',
    httpOnly: true,
  });
  res.redirect(302, config.webOrigin);
}

export async function getSessionFromCookieHeader(
  cookieHeader: string | undefined,
): Promise<UserSession | null> {
  const sessionId = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!sessionId) return null;
  const raw = await getRedis().get(`switchboard:session:${sessionId}`);
  if (!raw) return null;
  const result = sessionSchema.safeParse(JSON.parse(raw));
  return result.success ? result.data : null;
}

export async function getRequestSession(req: Request): Promise<UserSession | null> {
  return getSessionFromCookieHeader(req.headers.cookie);
}

export async function endLogin(req: Request, res: Response): Promise<void> {
  const sessionId = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (sessionId) await getRedis().del(`switchboard:session:${sessionId}`);
  clearCookie(res, SESSION_COOKIE, '/');
  res.sendStatus(204);
}

export function isWorkspaceMember(session: UserSession, workspace: string): boolean {
  return session.workspaces.some((membership) => membership.id === workspace);
}
