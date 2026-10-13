import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { CloudApiError } from './client.js';
import { CloudConfigError, normalizeCloudUrl } from './config.js';
import type { SecretStore, StoredTokens } from './secrets.js';

export const DEFAULT_SITE = 'https://ptch.vercel.app';
export const CLIENT_ID = 'patch-cli';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Refresh a little early so a request never leaves with a token about to expire. */
const REFRESH_SKEW_MS = 60_000;

export interface Discovery {
  api: string;
  authorize: string;
  token: string;
  revoke: string;
}

export function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** RFC 7636: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: pkceChallenge(verifier), state: base64url(randomBytes(16)) };
}

/**
 * Asks the website where the API is and how to sign in. Only addresses the CLI would also accept
 * from the user are used: the API must be HTTPS (or a private-network address), and the sign-in
 * page must live on the same origin as the site that answered.
 */
export async function discover(site: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const base = normalizeSite(site);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/.well-known/patch-cloud`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CloudApiError(`Cannot reach ${base}. Check your connection.`, 0, 'unreachable');
  }
  if (!response.ok) {
    throw new CloudApiError(
      `${base} is not set up for Patch Cloud sign-in (answered ${response.status}).`,
      response.status,
      'not_configured',
    );
  }
  const doc = (await response.json().catch(() => null)) as Partial<Discovery> | null;
  if (!doc?.api || !doc.authorize || !doc.token) {
    throw new CloudConfigError(`${base} answered with an unexpected sign-in description.`);
  }
  const api = new URL(normalizeCloudUrl(doc.api));
  const authorize = new URL(doc.authorize);
  const token = new URL(doc.token);
  // The revoke address is held to the same rule as the token address; without one it is derived.
  const revoke = doc.revoke ? new URL(doc.revoke) : null;
  if (authorize.origin !== new URL(base).origin) {
    throw new CloudConfigError('The sign-in page is not on the site you asked for. Stopping.');
  }
  if (token.origin !== api.origin) {
    throw new CloudConfigError('The token address is not on the API host. Stopping.');
  }
  if (revoke && revoke.origin !== api.origin) {
    throw new CloudConfigError('The sign-out address is not on the API host. Stopping.');
  }
  return {
    api: api.origin,
    authorize: authorize.toString(),
    token: token.toString(),
    revoke: revoke ? revoke.toString() : `${api.origin}/api/v1/oauth/revoke`,
  };
}

export function normalizeSite(input: string): string {
  const url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new CloudConfigError('The site must use https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CloudConfigError('The site must start with https://.');
  }
  return url.origin;
}

export async function openBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Refusing to open a non-web address.');
  const [file, args] =
    process.platform === 'win32'
      ? (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  await new Promise<void>((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{background:#0b0c0d;color:#a3a6ac;font:15px/1.5 system-ui,sans-serif}body{display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:380px;padding:28px;border:1px solid #2b2d31;border-radius:12px;background:#101113}h1{color:#ededef;font-size:20px;margin:0 0 8px}</style><main><h1>${title}</h1><p>${body}</p></main>`;

interface Callback {
  code?: string;
  error?: string;
}

/** Waits for the browser to come back to 127.0.0.1 with the authorization code. */
function listenForCallback(
  expectedState: string,
  signal?: AbortSignal,
): { port: Promise<number>; result: Promise<Callback>; close(): void } {
  let settle!: (value: Callback) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<Callback>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('referrer-policy', 'no-referrer');
    if (url.searchParams.get('state') !== expectedState) {
      // Not from our request (or a stale tab): ignore it, keep waiting for the real one.
      res
        .writeHead(400)
        .end(PAGE('Wrong request', 'This sign-in was not started here. Close this tab.'));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error) {
      res
        .writeHead(200)
        .end(PAGE('Not signed in', 'You cancelled the sign-in. Return to your terminal.'));
      settle({ error });
    } else if (code) {
      res
        .writeHead(200)
        .end(
          PAGE(
            'Signed in',
            'Patch CLI is signed in. You can close this tab and return to your terminal.',
          ),
        );
      settle({ code });
    } else {
      res.writeHead(400).end(PAGE('Wrong request', 'Nothing to sign in with.'));
    }
  });
  const timer = setTimeout(
    () => fail(new CloudApiError('Timed out waiting for the browser sign-in.', 0, 'timeout')),
    LOGIN_TIMEOUT_MS,
  );
  const onAbort = (): void => fail(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  signal?.addEventListener('abort', onAbort, { once: true });
  const port = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return {
    port,
    result,
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections();
    },
  };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(
  tokenUrl: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<StoredTokens> {
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CloudApiError('Cannot reach Patch Cloud to sign in.', 0, 'unreachable');
  }
  const body = (await response.json().catch(() => null)) as
    (Partial<TokenResponse> & { error?: string; error_description?: string }) | null;
  if (!response.ok || !body?.access_token || !body.refresh_token) {
    throw new CloudApiError(
      body?.error_description ?? `Patch Cloud refused the sign-in (${response.status}).`,
      response.status,
      body?.error ?? 'error',
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

export interface LoginHooks {
  fetchImpl?: typeof fetch;
  open?: (url: string) => Promise<void>;
  /** Called with the address to visit, whether or not the browser opened. */
  announce: (url: string) => void;
  signal?: AbortSignal;
  deviceName?: string;
}

/** The whole browser sign-in: PKCE, loopback redirect, code exchange. Returns tokens and the API. */
export async function loginWithBrowser(
  site: string,
  hooks: LoginHooks,
): Promise<{ tokens: StoredTokens; discovery: Discovery }> {
  const fetchImpl = hooks.fetchImpl ?? fetch;
  const discovery = await discover(site, fetchImpl);
  const pkce = newPkce();
  const listener = listenForCallback(pkce.state, hooks.signal);
  try {
    const port = await listener.port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = new URL(discovery.authorize);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: pkce.state,
      device_name: hooks.deviceName ?? `${hostname()} (ptch)`,
    }).toString();
    hooks.announce(url.toString());
    await (hooks.open ?? openBrowser)(url.toString()).catch(() => undefined);

    const callback = await listener.result;
    if (callback.error || !callback.code) {
      throw new CloudApiError(
        callback.error === 'access_denied'
          ? 'Sign-in cancelled in the browser.'
          : `The sign-in failed (${callback.error ?? 'no code'}).`,
        0,
        callback.error ?? 'error',
      );
    }
    const tokens = await tokenRequest(
      discovery.token,
      {
        grant_type: 'authorization_code',
        code: callback.code,
        code_verifier: pkce.verifier,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
      },
      fetchImpl,
    );
    return { tokens, discovery };
  } finally {
    listener.close();
  }
}

/**
 * Hands out a valid access token, refreshing it (once at a time) when it is about to expire. The
 * refresh token rotates on every use, so the new pair is saved before the new access token is used.
 */
export class TokenSession {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly store: SecretStore,
    private readonly tokenUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private tokens: StoredTokens | null = null,
  ) {}

  async accessToken(): Promise<string> {
    this.tokens ??= await this.store.get();
    if (!this.tokens) throw new CloudApiError('Not signed in. Run: ptch login', 401, 'signed_out');
    if (this.tokens.accessExpiresAt - REFRESH_SKEW_MS > Date.now()) return this.tokens.accessToken;
    return this.refresh();
  }

  /** Forces a refresh (after a 401). Concurrent callers share one request. */
  refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    // Another process (a second terminal) may already have refreshed: read what is stored first.
    const stored = (await this.store.get()) ?? this.tokens;
    if (!stored) throw new CloudApiError('Not signed in. Run: ptch login', 401, 'signed_out');
    // A different, still-valid token in the keystore means another process already renewed it.
    if (
      stored.accessToken !== this.tokens?.accessToken &&
      stored.accessExpiresAt - REFRESH_SKEW_MS > Date.now()
    ) {
      this.tokens = stored;
      return stored.accessToken;
    }
    try {
      const next = await tokenRequest(
        this.tokenUrl,
        { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: CLIENT_ID },
        this.fetchImpl,
      );
      await this.store.set(next);
      this.tokens = next;
      return next.accessToken;
    } catch (error) {
      if (error instanceof CloudApiError && error.code === 'invalid_grant') {
        await this.store.clear();
        this.tokens = null;
        throw new CloudApiError(
          'Your sign-in expired or was revoked. Run: ptch login',
          401,
          'signed_out',
        );
      }
      throw error;
    }
  }
}

/** Signs this device out on the server (best effort) and forgets the tokens. */
export async function logoutDevice(
  store: SecretStore,
  revokeUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const tokens = await store.get();
  let revoked = false;
  if (tokens && revokeUrl) {
    try {
      const response = await fetchImpl(revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
      revoked = response.ok;
    } catch {
      revoked = false;
    }
  }
  await store.clear();
  return revoked;
}
