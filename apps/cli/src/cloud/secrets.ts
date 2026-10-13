import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePatchPaths } from '@patch/core';

/** The OAuth tokens of this machine's sign-in. The only secrets the CLI keeps for Patch Cloud. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  accessExpiresAt: number;
}

export interface SecretStore {
  /** Where the secrets live, for messages: "Windows DPAPI", "macOS Keychain", ... */
  readonly label: string;
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

function parse(text: string): StoredTokens | null {
  try {
    const value = JSON.parse(text) as Partial<StoredTokens>;
    if (
      typeof value.accessToken === 'string' &&
      typeof value.refreshToken === 'string' &&
      typeof value.accessExpiresAt === 'number'
    ) {
      return value as StoredTokens;
    }
  } catch {
    // unreadable: treated as signed out
  }
  return null;
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows has no POSIX modes
  }
  renameSync(temp, path);
}

/** Runs a program, feeding `input` on stdin (so secrets never appear in a command line). */
function run(
  file: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/** A private file in the profile. The fallback where the platform offers no keystore. */
export class FileSecretStore implements SecretStore {
  readonly label: string;
  constructor(private readonly path: string) {
    this.label = `a private file (${path})`;
  }
  async get(): Promise<StoredTokens | null> {
    return existsSync(this.path) ? parse(readFileSync(this.path, 'utf8')) : null;
  }
  async set(tokens: StoredTokens): Promise<void> {
    writePrivate(this.path, JSON.stringify(tokens));
  }
  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($t); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const DPAPI_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $t=([Console]::In.ReadToEnd()).Trim(); $b=[Convert]::FromBase64String($t); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

/** Windows: the file holds a DPAPI blob only this Windows user (on this machine) can decrypt. */
export class DpapiSecretStore implements SecretStore {
  readonly label = 'Windows data protection (DPAPI), bound to your Windows account';
  constructor(private readonly path: string) {}

  private powershell(script: string, input: string) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);
  }

  async get(): Promise<StoredTokens | null> {
    if (!existsSync(this.path)) return null;
    const { code, stdout } = await this.powershell(
      DPAPI_UNPROTECT,
      readFileSync(this.path, 'utf8'),
    );
    return code === 0 ? parse(stdout.trim()) : null;
  }
  async set(tokens: StoredTokens): Promise<void> {
    const { code, stdout } = await this.powershell(DPAPI_PROTECT, JSON.stringify(tokens));
    if (code !== 0 || !stdout.trim()) throw new Error('Windows could not protect the tokens.');
    writePrivate(this.path, stdout.trim());
  }
  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

/** macOS Keychain through the `security` tool; the secret goes in on stdin, not on a command line. */
export class KeychainSecretStore implements SecretStore {
  readonly label = 'the macOS Keychain';
  constructor(private readonly account: string) {}

  async get(): Promise<StoredTokens | null> {
    const { code, stdout } = await run('security', [
      'find-generic-password',
      '-s',
      'patch-cloud',
      '-a',
      this.account,
      '-w',
    ]);
    return code === 0 ? parse(stdout.trim()) : null;
  }
  async set(tokens: StoredTokens): Promise<void> {
    // `security -i` reads commands from stdin; the JSON has no quotes or spaces to escape.
    const hex = Buffer.from(JSON.stringify(tokens)).toString('hex');
    const { code } = await run(
      'security',
      ['-i'],
      `add-generic-password -U -s patch-cloud -a ${this.account} -X ${hex}\n`,
    );
    if (code !== 0) throw new Error('The macOS Keychain refused the tokens.');
  }
  async clear(): Promise<void> {
    await run('security', ['delete-generic-password', '-s', 'patch-cloud', '-a', this.account]);
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool`. */
export class SecretToolStore implements SecretStore {
  readonly label = 'the Linux Secret Service (libsecret)';
  constructor(private readonly account: string) {}

  async get(): Promise<StoredTokens | null> {
    const { code, stdout } = await run('secret-tool', [
      'lookup',
      'service',
      'patch-cloud',
      'account',
      this.account,
    ]);
    return code === 0 ? parse(stdout.trim()) : null;
  }
  async set(tokens: StoredTokens): Promise<void> {
    const { code } = await run(
      'secret-tool',
      ['store', '--label=Patch Cloud', 'service', 'patch-cloud', 'account', this.account],
      JSON.stringify(tokens),
    );
    if (code !== 0) throw new Error('The Secret Service refused the tokens.');
  }
  async clear(): Promise<void> {
    await run('secret-tool', ['clear', 'service', 'patch-cloud', 'account', this.account]);
  }
}

function hasProgram(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(name, ['--version'], { windowsHide: true }, (error) => {
      // A missing program fails with ENOENT; any other outcome means it exists.
      resolve(!(error && (error as NodeJS.ErrnoException).code === 'ENOENT'));
    });
  });
}

/** The best keystore this machine has. PATCH_CLOUD_SECRET_STORE=file forces the private file. */
export async function createSecretStore(
  env: NodeJS.ProcessEnv,
  homeDir?: string,
  platform: NodeJS.Platform = process.platform,
  account = 'default',
): Promise<SecretStore> {
  const home = resolvePatchPaths(env, homeDir).home;
  const file = join(home, 'cloud-secrets.json');
  if (env.PATCH_CLOUD_SECRET_STORE === 'file') return new FileSecretStore(file);
  if (platform === 'win32') return new DpapiSecretStore(join(home, 'cloud-secrets.dpapi'));
  if (platform === 'darwin' && (await hasProgram('security')))
    return new KeychainSecretStore(account);
  if (platform === 'linux' && (await hasProgram('secret-tool'))) {
    // Only if a Secret Service is actually reachable (a headless box usually has none).
    const probe = await run('secret-tool', [
      'lookup',
      'service',
      'patch-cloud',
      'account',
      '_probe',
    ]).catch(() => null);
    if (probe && probe.code !== null && probe.code <= 1) return new SecretToolStore(account);
  }
  return new FileSecretStore(file);
}
