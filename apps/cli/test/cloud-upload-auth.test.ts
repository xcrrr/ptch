import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from '../src/cloud/auth.js';
import { CloudConfigError } from '../src/cloud/config.js';
import { SnapshotError, buildArchive, planSnapshot } from '../src/cloud/snapshot.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function doc(over: Record<string, unknown> = {}): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        api: 'https://api.example.test/api/v1',
        authorize: 'https://site.example.test/authorize',
        token: 'https://api.example.test/api/v1/oauth/token',
        revoke: 'https://api.example.test/api/v1/oauth/revoke',
        ...over,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
}

describe('sign-in discovery', () => {
  it('accepts a revoke address on the API host', async () => {
    const found = await discover('https://site.example.test', doc());
    expect(found.revoke).toBe('https://api.example.test/api/v1/oauth/revoke');
  });

  it('refuses a revoke address on another host (the refresh token would be sent there)', async () => {
    await expect(
      discover('https://site.example.test', doc({ revoke: 'https://evil.example.test/revoke' })),
    ).rejects.toThrow(CloudConfigError);
    await expect(
      discover('https://site.example.test', doc({ revoke: 'https://evil.example.test/revoke' })),
    ).rejects.toThrow(/sign-out address is not on the API host/);
  });

  it('derives the revoke address when there is none', async () => {
    const found = await discover('https://site.example.test', doc({ revoke: undefined }));
    expect(found.revoke).toBe('https://api.example.test/api/v1/oauth/revoke');
  });

  it('still refuses a token address on another host', async () => {
    await expect(
      discover('https://site.example.test', doc({ token: 'https://evil.example.test/token' })),
    ).rejects.toThrow(/token address/);
  });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'upload-repo-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'first\n');
  writeFileSync(join(dir, 'b.txt'), 'second\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

describe('uploading what the preview showed', () => {
  it('uploads the files as planned', async () => {
    const dir = repo();
    const plan = await planSnapshot(dir);
    const built = await buildArchive(plan);
    expect(built.manifest.fileCount).toBe(plan.files.length);
    expect(built.unreadable).toEqual([]);
  });

  it('stops when a file changed size after the preview', async () => {
    const dir = repo();
    const plan = await planSnapshot(dir);
    writeFileSync(join(dir, 'a.txt'), 'first\nand a lot more than was shown\n');
    await expect(buildArchive(plan)).rejects.toThrow(SnapshotError);
    await expect(buildArchive(plan)).rejects.toThrow(/a\.txt changed size since the preview/);
  });

  it('stops when a file became a symbolic link after the preview', async () => {
    const dir = repo();
    const secret = join(dir, '..', `secret-${Date.now()}.txt`);
    writeFileSync(secret, 'first\n');
    cleanups.push(() => rmSync(secret, { force: true }));
    const plan = await planSnapshot(dir);
    unlinkSync(join(dir, 'a.txt'));
    try {
      symlinkSync(secret, join(dir, 'a.txt'), 'file');
    } catch {
      return; // links are not available on this machine
    }
    await expect(buildArchive(plan)).rejects.toThrow(/no longer a regular file since the preview/);
  });

  it('reports a file that vanished as unreadable, as before', async () => {
    const dir = repo();
    const plan = await planSnapshot(dir);
    unlinkSync(join(dir, 'b.txt'));
    const built = await buildArchive(plan);
    expect(built.unreadable).toEqual(['b.txt']);
  });
});
