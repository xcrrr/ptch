import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DpapiSecretStore,
  FileSecretStore,
  createSecretStore,
  type StoredTokens,
} from '../src/cloud/secrets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-secrets-'));
  dirs.push(dir);
  return dir;
};

const TOKENS: StoredTokens = {
  accessToken: 'pat_example-access-token',
  refreshToken: 'prt_example-refresh-token',
  accessExpiresAt: 1_800_000_000_000,
};

describe('file secret store', () => {
  it('round-trips, is private on POSIX, and clears', async () => {
    const path = join(tmp(), 'sub', 'secrets.json');
    const store = new FileSecretStore(path);
    expect(await store.get()).toBeNull();
    await store.set(TOKENS);
    expect(await store.get()).toEqual(TOKENS);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('treats a damaged file as signed out instead of crashing', async () => {
    const path = join(tmp(), 'secrets.json');
    const store = new FileSecretStore(path);
    await store.set(TOKENS);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{not json');
    expect(await store.get()).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows DPAPI store', () => {
  it('encrypts on disk and decrypts for the same user', async () => {
    const path = join(tmp(), 'secrets.dpapi');
    const store = new DpapiSecretStore(path);
    await store.set(TOKENS);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('pat_example');
    expect(onDisk).not.toContain('prt_example');
    expect(await store.get()).toEqual(TOKENS);
    await store.clear();
    expect(await store.get()).toBeNull();
  }, 30_000);
});

describe('store selection', () => {
  it('uses DPAPI on Windows and a private file when forced', async () => {
    const home = tmp();
    const win = await createSecretStore({ PATCH_HOME: home }, home, 'win32');
    expect(win).toBeInstanceOf(DpapiSecretStore);
    const forced = await createSecretStore(
      { PATCH_HOME: home, PATCH_CLOUD_SECRET_STORE: 'file' },
      home,
      'win32',
    );
    expect(forced).toBeInstanceOf(FileSecretStore);
  });
});
