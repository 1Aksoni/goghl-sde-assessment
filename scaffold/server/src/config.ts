// Every setting comes from the environment. The defaults match the harness,
// so this runs with no .env file. If ../../.env exists it is loaded first.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: defaults apply
}

import { z } from 'zod';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const envSchema = z.object({
  port: z.coerce.number().int().positive(),
  webOrigin: z.string().url(),
  graderToken: z.string().min(1),
  mongoUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  elasticsearchUrl: z.string().url(),
  pigeonUrl: z.string().url(),
  pigeonWebhookSecret: z.string().min(1),
  pigeonKeyWsAcme: z.string().min(1),
  pigeonKeyWsGlobex: z.string().min(1),
  oidcIssuer: z.string().url(),
  oidcClientId: z.string().min(1),
  oidcClientSecret: z.string().min(1),
  oidcRedirectUri: z.string().url(),
  payboxUrl: z.string().url(),
  payboxSecretKey: z.string().min(1),
  payboxPublishableKey: z.string().min(1),
  payboxWebhookSecret: z.string().min(1),
});

const validated = envSchema.parse({
  port: env('PORT', '4000'),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  graderToken: env('GRADER_TOKEN', 'grader-dev-token'),
  mongoUrl: env('MONGO_URL', 'mongodb://localhost:27017/switchboard'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  elasticsearchUrl: env('ELASTICSEARCH_URL', 'http://localhost:9200'),
  pigeonUrl: env('PIGEON_URL', 'http://localhost:4010'),
  pigeonWebhookSecret: env('PIGEON_WEBHOOK_SECRET', 'whsec_pigeon_dev'),
  pigeonKeyWsAcme: env('PIGEON_KEY_WS_ACME', 'pk_acme_7d1f0a'),
  pigeonKeyWsGlobex: env('PIGEON_KEY_WS_GLOBEX', 'pk_globex_c93b22'),
  oidcIssuer: env('OIDC_ISSUER', 'http://localhost:4020'),
  oidcClientId: env('OIDC_CLIENT_ID', 'switchboard-web'),
  oidcClientSecret: env('OIDC_CLIENT_SECRET', 'dev-secret-not-for-production'),
  oidcRedirectUri: env('OIDC_REDIRECT_URI', 'http://localhost:4000/auth/callback'),
  payboxUrl: env('PAYBOX_URL', 'http://localhost:4030'),
  payboxSecretKey: env('PAYBOX_SECRET_KEY', 'sk_test_paybox_51c0de'),
  payboxPublishableKey: env('PAYBOX_PUBLISHABLE_KEY', 'pk_test_paybox_9a7b3e'),
  payboxWebhookSecret: env('PAYBOX_WEBHOOK_SECRET', 'whsec_paybox_dev'),
});

export const config = {
  port: validated.port,
  webOrigin: validated.webOrigin,
  graderToken: validated.graderToken,
  mongoUrl: validated.mongoUrl,
  redisUrl: validated.redisUrl,
  elasticsearchUrl: validated.elasticsearchUrl,
  pigeon: {
    url: validated.pigeonUrl,
    webhookSecret: validated.pigeonWebhookSecret,
    apiKeys: {
      ws_acme: validated.pigeonKeyWsAcme,
      ws_globex: validated.pigeonKeyWsGlobex,
    } as Record<string, string>,
  },
  oidc: {
    issuer: validated.oidcIssuer,
    clientId: validated.oidcClientId,
    clientSecret: validated.oidcClientSecret,
    redirectUri: validated.oidcRedirectUri,
  },
  paybox: {
    url: validated.payboxUrl,
    secretKey: validated.payboxSecretKey,
    publishableKey: validated.payboxPublishableKey,
    webhookSecret: validated.payboxWebhookSecret,
  },
};
