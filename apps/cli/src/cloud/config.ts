import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPrivateHost } from '@patch/cloud-protocol';
import { resolvePatchPaths } from '@patch/core';

export interface CloudCredentials {
  url: string;
  token: string;
}

/** How this machine signed in with "ptch login" (the tokens themselves are in the keystore). */
export interface OAuthInfo {
  site: string;
  tokenUrl: string;
  revokeUrl: string;
}

interface CloudFile {
  url?: string;
  token?: string;
  oauth?: OAuthInfo;
  /** Local repository root (absolute path) to cloud project id. */
  projects?: Record<string, string>;
}

export class CloudConfigError extends Error {
  override readonly name = 'CloudConfigError';
}

function filePath(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return join(resolvePatchPaths(env, homeDir).home, 'cloud.json');
}

function read(path: string): CloudFile {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CloudFile) : {};
  } catch {
    throw new CloudConfigError(
      `${path} is not valid JSON. Fix or remove it, then run "ptch cloud login" again.`,
    );
  }
}

function write(path: string, file: CloudFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows has no POSIX modes; the file lives in the user's profile.
  }
  renameSync(temp, path);
}

/** A cloud URL the CLI may send its token to: HTTPS, or plain HTTP to a private-network or loopback address. */
export function normalizeCloudUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    throw new CloudConfigError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CloudConfigError('The Patch Cloud URL must start with http:// or https://.');
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new CloudConfigError(
      `Refusing plain HTTP to ${url.hostname}: your token would travel unencrypted. Use https://, or the private-network address of the host.`,
    );
  }
  if (url.username || url.password) {
    throw new CloudConfigError('Put the token in "ptch cloud login", not in the URL.');
  }
  return `${url.protocol}//${url.host}`;
}

export class CloudConfigStore {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly homeDir?: string,
  ) {}

  get path(): string {
    return filePath(this.env, this.homeDir);
  }

  /** Static-token credentials: the environment (PATCH_CLOUD_URL / PATCH_CLOUD_TOKEN) or the saved file. */
  credentials(): CloudCredentials | null {
    const file = read(this.path);
    const url = this.env.PATCH_CLOUD_URL?.trim() || file.url;
    const token = this.env.PATCH_CLOUD_TOKEN?.trim() || file.token;
    if (!url || !token) return null;
    return { url: normalizeCloudUrl(url), token };
  }

  /** The browser sign-in of this machine, if any. */
  oauth(): (OAuthInfo & { url: string }) | null {
    const file = read(this.path);
    return file.oauth && file.url ? { ...file.oauth, url: normalizeCloudUrl(file.url) } : null;
  }

  saveOAuth(url: string, info: OAuthInfo): void {
    const { token: _token, ...rest } = read(this.path);
    write(this.path, { ...rest, url: normalizeCloudUrl(url), oauth: info });
  }

  saveCredentials(creds: CloudCredentials): void {
    const file = read(this.path);
    write(this.path, { ...file, url: normalizeCloudUrl(creds.url), token: creds.token });
  }

  clearCredentials(): void {
    const { url: _url, token: _token, oauth: _oauth, ...rest } = read(this.path);
    write(this.path, rest);
  }

  projectFor(root: string): string | undefined {
    return read(this.path).projects?.[root];
  }

  linkProject(root: string, projectId: string): void {
    const file = read(this.path);
    write(this.path, { ...file, projects: { ...file.projects, [root]: projectId } });
  }
}
