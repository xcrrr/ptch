import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_SITE,
  TokenSession,
  loginWithBrowser,
  logoutDevice,
  openBrowser,
} from '../cloud/auth.js';
import { CloudApi } from '../cloud/client.js';
import { CloudConfigStore } from '../cloud/config.js';
import { createSecretStore, type SecretStore } from '../cloud/secrets.js';
import { buildArchive, planSnapshot, type SnapshotPlan } from '../cloud/snapshot.js';

const execFileAsync = promisify(execFile);

/** What the cloud view uses of the Patch Cloud API (tests supply a fake with these methods). */
export type CloudViewApi = Pick<
  CloudApi,
  | 'url'
  | 'status'
  | 'me'
  | 'listProjects'
  | 'projectDetail'
  | 'createProject'
  | 'uploadSnapshot'
  | 'listTasks'
  | 'getTask'
  | 'tasksByIds'
  | 'events'
  | 'follow'
  | 'listConversations'
  | 'createConversation'
  | 'getConversation'
  | 'sendMessage'
  | 'confirmProposal'
  | 'dismissProposal'
  | 'brainGraph'
  | 'brainEntry'
  | 'addBrainEntry'
>;

export interface LoginHooks {
  /** Called with the address to visit, whether or not the browser opened. */
  announce: (url: string) => void;
  signal: AbortSignal;
}

/** Everything the cloud view needs from the machine it runs on: sign-in, the repository, uploads. */
export interface CloudBackend {
  /** Where the repository is (the directory `ptch` was started in). */
  readonly cwd: string;
  /** A saved sign-in exists on this machine (no network needed to know). */
  isSignedIn(): boolean;
  /** The saved Patch Cloud address, if any. */
  host(): string | null;
  /** The API client for the saved sign-in, or null when there is none. */
  connect(): Promise<CloudViewApi | null>;
  /** The browser sign-in (PKCE). Resolves with the client for the new sign-in. */
  login(hooks: LoginHooks): Promise<CloudViewApi>;
  /** Signs this device out (and revokes it on Patch Cloud when it can be reached). */
  logout(): Promise<{ revoked: boolean }>;
  /** The git root of `cwd` and the cloud project linked to it, if any. */
  linkedProject(): Promise<{ root: string | null; projectId?: string }>;
  linkProject(root: string, projectId: string): void;
  planPush(): Promise<SnapshotPlan>;
  buildArchive: typeof buildArchive;
}

export interface BackendOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** Test hooks. */
  secretStore?: SecretStore;
  openBrowser?: (url: string) => Promise<void>;
}

async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The real backend: the config file and keystore of this machine, the browser, git. */
export function createBackend(options: BackendOptions): CloudBackend {
  const config = new CloudConfigStore(options.env, options.homeDir);
  const store = async (): Promise<SecretStore> =>
    options.secretStore ?? (await createSecretStore(options.env, options.homeDir));

  const connect = async (): Promise<CloudViewApi | null> => {
    const creds = config.credentials();
    if (creds) return new CloudApi(creds, options.fetchImpl);
    const oauth = config.oauth();
    if (!oauth) return null;
    const session = new TokenSession(await store(), oauth.tokenUrl, options.fetchImpl);
    return new CloudApi({ url: oauth.url, token: '' }, options.fetchImpl, session);
  };

  return {
    cwd: options.cwd,
    isSignedIn() {
      try {
        return config.credentials() !== null || config.oauth() !== null;
      } catch {
        return false;
      }
    },
    host() {
      try {
        return config.credentials()?.url ?? config.oauth()?.url ?? null;
      } catch {
        return null;
      }
    },
    connect,
    async login(hooks) {
      const site =
        options.env.PATCH_SITE?.trim() ||
        (() => {
          try {
            return config.oauth()?.site;
          } catch {
            return undefined;
          }
        })() ||
        DEFAULT_SITE;
      const { tokens, discovery } = await loginWithBrowser(site, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        // PATCH_NO_BROWSER=1: only show the address (a remote shell, a machine without a browser).
        open:
          options.openBrowser ??
          (options.env.PATCH_NO_BROWSER === '1' ? async () => undefined : openBrowser),
        announce: hooks.announce,
        signal: hooks.signal,
      });
      const secrets = await store();
      await secrets.set(tokens);
      config.saveOAuth(discovery.api, {
        site: new URL(discovery.authorize).origin,
        tokenUrl: discovery.token,
        revokeUrl: discovery.revoke,
      });
      const api = await connect();
      if (!api) throw new Error('The sign-in was not saved.');
      return api;
    },
    async logout() {
      const oauth = config.oauth();
      let revoked = false;
      if (oauth) revoked = await logoutDevice(await store(), oauth.revokeUrl, options.fetchImpl);
      config.clearCredentials();
      return { revoked };
    },
    async linkedProject() {
      const root = await gitRoot(options.cwd);
      if (!root) return { root: null };
      const projectId = config.projectFor(root);
      return projectId ? { root, projectId } : { root };
    },
    linkProject(root, projectId) {
      config.linkProject(root, projectId);
    },
    planPush: () => planSnapshot(options.cwd),
    buildArchive,
  };
}
