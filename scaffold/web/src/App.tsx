import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import './App.css';

interface Workspace {
  id: string;
  role: 'admin' | 'agent';
}

interface User {
  sub: string;
  workspaces: Workspace[];
}

interface Conversation {
  contact: string;
  assignee: string | null;
  closed: boolean;
  lastActivityAt: string;
  inboundCount: number;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: string;
  createdAt: string;
}

interface ConversationPage {
  conversations: Conversation[];
  nextCursor: string | null;
}

interface MessageThread {
  contact: string;
  assignee: string | null;
  closed: boolean;
  messages: Message[];
}

interface WorkspaceFrame {
  seq: number;
  type: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as
    | { error?: { message?: string } }
    | null;
  return new Error(body?.error?.message ?? `Request failed (${response.status})`);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    .format(new Date(value));
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState('');
  const [thread, setThread] = useState<MessageThread | null>(null);
  const [draft, setDraft] = useState('');
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lastSeqByWorkspace = useRef<Record<string, number>>({});
  const selectedContactRef = useRef('');
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/me', { credentials: 'same-origin' })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw await responseError(response);
        return response.json() as Promise<User>;
      })
      .then((result) => {
        if (!active) return;
        setUser(result);
        if (result?.workspaces.length) setWorkspaceId(result.workspaces[0].id);
      })
      .catch((requestError: unknown) => {
        if (active) setError(errorText(requestError));
      })
      .finally(() => {
        if (active) setUserLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const loadConversations = useCallback(async (append = false, cursor?: string) => {
    if (!workspaceId) return;
    const url = new URL('/api/conversations', window.location.origin);
    url.searchParams.set('workspace', workspaceId);
    url.searchParams.set('limit', '30');
    if (cursor) url.searchParams.set('before', cursor);

    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw await responseError(response);
    const page = await response.json() as ConversationPage;
    setConversations((current) => append
      ? [...current, ...page.conversations.filter(
          (item) => !current.some((existing) => existing.contact === item.contact),
        )]
      : page.conversations);
    setNextCursor(page.nextCursor);
  }, [workspaceId]);

  const loadThread = useCallback(async (contact: string, signal?: AbortSignal) => {
    if (!workspaceId || !contact) return;
    const url = new URL(
      `/api/conversations/${encodeURIComponent(contact)}/messages`,
      window.location.origin,
    );
    url.searchParams.set('workspace', workspaceId);
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw await responseError(response);
    setThread(await response.json() as MessageThread);
  }, [workspaceId]);

  useEffect(() => {
    selectedContactRef.current = selectedContact;
  }, [selectedContact]);

  useEffect(() => {
    if (!workspaceId || !user) return;
    let active = true;
    setLoadingInbox(true);
    setError('');
    setSelectedContact('');
    setThread(null);
    loadConversations()
      .then(() => {
        if (active) setLoadingInbox(false);
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(errorText(requestError));
          setLoadingInbox(false);
        }
      });
    return () => {
      active = false;
    };
  }, [loadConversations, user, workspaceId]);

  useEffect(() => {
    if (!selectedContact) {
      setThread(null);
      return;
    }
    const controller = new AbortController();
    setThread(null);
    setLoadingThread(true);
    loadThread(selectedContact, controller.signal)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(errorText(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingThread(false);
      });
    return () => controller.abort();
  }, [loadThread, selectedContact]);

  useEffect(() => {
    if (thread?.messages.length) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [thread?.messages.length, selectedContact]);

  useEffect(() => {
    if (!workspaceId || !user) return;
    let active = true;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (!active) return;
      setConnection(attempts === 0 ? 'connecting' : 'reconnecting');
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const after = lastSeqByWorkspace.current[workspaceId] ?? 0;
      socket = new WebSocket(
        `${scheme}//${window.location.host}/ws?workspace=${encodeURIComponent(workspaceId)}&after=${after}`,
      );
      socket.onopen = () => {
        attempts = 0;
        setConnection('live');
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as WorkspaceFrame;
          if (!Number.isSafeInteger(frame.seq)) return;
          const previous = lastSeqByWorkspace.current[workspaceId] ?? 0;
          if (frame.seq <= previous) return;
          lastSeqByWorkspace.current[workspaceId] = frame.seq;
          void loadConversations().catch((requestError: unknown) => {
            setError(errorText(requestError));
          });
          if (frame.contact && frame.contact === selectedContactRef.current) {
            void loadThread(frame.contact).catch((requestError: unknown) => {
              setError(errorText(requestError));
            });
          }
        } catch {
          setError('Received an unreadable live update.');
        }
      };
      socket.onclose = () => {
        if (!active) return;
        attempts += 1;
        setConnection('reconnecting');
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** (attempts - 1), 10_000));
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [loadConversations, loadThread, user, workspaceId]);

  const runConversationAction = async (action: 'claim' | 'close' | 'reopen') => {
    if (!workspaceId || !selectedContact) return;
    setActionBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(selectedContact)}/${action}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: workspaceId }),
        },
      );
      if (!response.ok) throw await responseError(response);
      await Promise.all([loadConversations(), loadThread(selectedContact)]);
      setNotice({
        claim: 'Conversation assigned to you.',
        close: 'Conversation closed.',
        reopen: 'Conversation reopened.',
      }[action]);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setActionBusy(false);
    }
  };

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedContact || !workspaceId) return;
    const clientRef = crypto.randomUUID();
    setSending(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(selectedContact)}/reply`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': clientRef,
          },
          body: JSON.stringify({ workspace: workspaceId, text, client_ref: clientRef }),
        },
      );
      if (!response.ok) throw await responseError(response);
      setDraft('');
      setNotice('Reply queued for delivery.');
      await Promise.all([loadConversations(), loadThread(selectedContact)]);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setSending(false);
    }
  };

  const signOut = async () => {
    setError('');
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw await responseError(response);
      setUser(null);
      setWorkspaceId('');
      setConversations([]);
      setSelectedContact('');
      setThread(null);
    } catch (requestError) {
      setError(errorText(requestError));
    }
  };

  if (userLoading) {
    return <main className="loading-screen">Loading your workspace…</main>;
  }

  if (!user) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="brand-mark">S</div>
          <p className="eyebrow">TEAM MESSAGING</p>
          <h1>Switchboard</h1>
          <p className="login-copy">A shared inbox for thoughtful customer support.</p>
          {error && <p className="alert error-alert">{error}</p>}
          <a className="primary-button login-button" href="/auth/login">Sign in</a>
          <p className="login-footnote">Sign in with your organization account.</p>
        </section>
      </main>
    );
  }

  const workspaceName = workspaceId === 'ws_acme' ? 'Acme' : 'Globex';

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small-mark">S</div>
          <span>Switchboard</span>
        </div>
        <label className="workspace-label" htmlFor="workspace-select">WORKSPACE</label>
        <select
          id="workspace-select"
          className="workspace-select"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        >
          {user.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.id === 'ws_acme' ? 'Acme' : workspace.id === 'ws_globex' ? 'Globex' : workspace.id}
              {' · '}{workspace.role}
            </option>
          ))}
        </select>

        <div className="inbox-heading">
          <div>
            <p className="eyebrow">INBOX</p>
            <h2>{workspaceName}</h2>
          </div>
          <span className="count-pill">{conversations.length}</span>
        </div>
        <div className="conversation-list" aria-label="Conversations">
          {loadingInbox && conversations.length === 0 && <p className="muted list-empty">Loading inbox…</p>}
          {!loadingInbox && conversations.length === 0 && (
            <p className="muted list-empty">No conversations yet. New customer messages will appear here.</p>
          )}
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.contact}
              className={`conversation-row ${selectedContact === conversation.contact ? 'selected' : ''}`}
              onClick={() => {
                setSelectedContact(conversation.contact);
                setError('');
                setNotice('');
              }}
            >
              <span className="avatar">{conversation.contact.slice(-2)}</span>
              <span className="conversation-copy">
                <span className="conversation-contact">{conversation.contact}</span>
                <span className="conversation-preview">
                  {conversation.closed ? 'Closed' : conversation.assignee ? `Assigned to ${conversation.assignee}` : 'Unassigned'}
                </span>
              </span>
              <span className="conversation-time">{formatTime(conversation.lastActivityAt)}</span>
            </button>
          ))}
          {nextCursor && (
            <button
              className="load-more"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                try {
                  await loadConversations(true, nextCursor);
                } catch (requestError) {
                  setError(errorText(requestError));
                } finally {
                  setLoadingMore(false);
                }
              }}
            >
              {loadingMore ? 'Loading…' : 'Load older'}
            </button>
          )}
        </div>
        <div className="profile">
          <span className="profile-avatar">{user.sub.slice(-2).toUpperCase()}</span>
          <span className="profile-info">
            <strong>{user.sub}</strong>
            <span>{user.workspaces.find((item) => item.id === workspaceId)?.role ?? 'member'}</span>
          </span>
          <button type="button" className="signout-button" onClick={signOut} aria-label="Sign out">↗</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Inbox</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{selectedContact || 'All conversations'}</strong>
          </div>
          <div className="live-indicator">
            <span className={`live-dot ${connection === 'live' ? 'connected' : ''}`} />
            {connection === 'live' ? 'Live updates on' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </div>
        </header>

        {error && <div className="alert error-alert global-alert" role="alert">{error}</div>}
        {notice && <div className="alert notice-alert global-alert" role="status">{notice}</div>}

        {!selectedContact ? (
          <div className="empty-state">
            <div className="empty-icon">✉</div>
            <h2>Your inbox, in sync.</h2>
            <p>Choose a conversation to read the thread and reply to your customer.</p>
          </div>
        ) : (
          <section className="thread-panel">
            <header className="thread-header">
              <div className="customer-heading">
                <span className="avatar large-avatar">{selectedContact.slice(-2)}</span>
                <div>
                  <h1>{selectedContact}</h1>
                  <p>{thread?.assignee ? `Assigned to ${thread.assignee}` : 'No one is assigned'} · {thread?.closed ? 'Closed' : 'Open'}</p>
                </div>
              </div>
              <div className="thread-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={actionBusy || thread?.assignee === user.sub}
                  onClick={() => void runConversationAction('claim')}
                >
                  {thread?.assignee === user.sub ? 'Assigned to you' : 'Claim'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={actionBusy || !thread}
                  onClick={() => void runConversationAction(thread?.closed ? 'reopen' : 'close')}
                >
                  {thread?.closed ? 'Reopen' : 'Close'}
                </button>
              </div>
            </header>

            <div className="message-list">
              {loadingThread && <p className="muted thread-loading">Loading conversation…</p>}
              {!loadingThread && thread?.messages.length === 0 && (
                <div className="thread-empty">
                  <p>This conversation has no messages yet.</p>
                  <span>You can still send the first reply.</span>
                </div>
              )}
              {thread?.messages.map((message) => (
                <article
                  className={`message ${message.direction === 'outbound' ? 'outgoing' : 'incoming'}`}
                  key={`${message.direction}-${message.id}`}
                >
                  <div className="message-bubble">
                    <p>{message.text}</p>
                    <footer>
                      <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                      {message.direction === 'outbound' && <span className="message-status">{message.status}</span>}
                    </footer>
                  </div>
                </article>
              ))}
              <div ref={threadEndRef} />
            </div>

            <form className="reply-composer" onSubmit={sendReply}>
              <textarea
                aria-label="Write a reply"
                placeholder={thread?.closed ? 'Reopen this conversation to reply' : 'Write a reply…'}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={sending || thread?.closed}
                rows={3}
              />
              <div className="composer-footer">
                <span>Replies are sent through the messaging provider.</span>
                <button className="primary-button send-button" type="submit" disabled={sending || !draft.trim() || thread?.closed}>
                  {sending ? 'Sending…' : 'Send reply'} <span aria-hidden="true">↗</span>
                </button>
              </div>
            </form>
          </section>
        )}
      </section>
    </main>
  );
}
