import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_FILE_BYTES,
  secretPathReason,
  type SnapshotManifest,
} from '@patch/cloud-protocol';
import { packTarGz, unsafePathReason, type ArchiveEntry } from '@patch/cloud-protocol/archive';

const execFileAsync = promisify(execFile);

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
}

export type DirtyKind = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflicted';

export interface SnapshotFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface SnapshotPlan {
  root: string;
  branch: string | null;
  baseCommit: string | null;
  /** Remote URL with any credentials removed, for display and for naming the project. */
  remote: string | null;
  files: SnapshotFile[];
  totalBytes: number;
  /** Tracked or untracked-but-not-ignored files that are left out, each with the reason. */
  excluded: Array<{ path: string; reason: string }>;
  /** Everything git reports as differing from the last commit (uploaded files carry these changes). */
  dirty: Array<{ path: string; kind: DirtyKind }>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (error) {
    const err = error as { code?: string; stderr?: string };
    if (err.code === 'ENOENT') throw new SnapshotError('git is not installed or not on PATH.');
    throw new SnapshotError(
      `git ${args[0]} failed: ${(err.stderr ?? '').trim() || (error as Error).message}`,
    );
  }
}

/** Strips `user:password@` from a remote URL so credentials never reach a screen or a server. */
export function cleanRemote(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/^[^@/\s]+:[^@/\s]*@/, '');
  }
}

function parseStatus(output: string): SnapshotPlan['dirty'] {
  const parts = output.split('\0').filter(Boolean);
  const dirty: SnapshotPlan['dirty'] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next field is the old name
    let kind: DirtyKind;
    if (code === '??') kind = 'untracked';
    else if (code.includes('U') || code === 'AA' || code === 'DD') kind = 'conflicted';
    else if (code[0] === 'R' || code[0] === 'C') kind = 'renamed';
    else if (code.includes('D')) kind = 'deleted';
    else if (code.includes('A')) kind = 'added';
    else kind = 'modified';
    dirty.push({ path, kind });
  }
  return dirty;
}

/**
 * Works out what a snapshot would contain, without reading file contents or sending anything.
 * The file list is `git ls-files --cached --others --exclude-standard`: tracked files plus
 * untracked files that are not ignored, at their current contents. Ignored files are never
 * included. Files that look like secrets are left out and listed.
 */
export async function planSnapshot(cwd: string): Promise<SnapshotPlan> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) throw new SnapshotError('This directory is not inside a git repository.');
  const [listing, status, head, branch, remote] = await Promise.all([
    git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => ''),
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
    git(root, ['remote', 'get-url', 'origin']).catch(() => ''),
  ]);

  const excluded: SnapshotPlan['excluded'] = [];
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const path of listing.split('\0').filter(Boolean)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const unsafe = unsafePathReason(path);
    if (unsafe) {
      excluded.push({ path, reason: unsafe });
      continue;
    }
    const secret = secretPathReason(path);
    if (secret) {
      excluded.push({ path, reason: `looks like a secret (${secret})` });
      continue;
    }
    let info;
    try {
      info = await lstat(join(root, path));
    } catch {
      continue; // tracked but deleted in the working tree: the deletion is a change, not a file
    }
    if (info.isSymbolicLink()) excluded.push({ path, reason: 'symbolic link' });
    else if (info.isDirectory()) excluded.push({ path, reason: 'submodule or nested repository' });
    else if (!info.isFile()) excluded.push({ path, reason: 'not a regular file' });
    else if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      excluded.push({ path, reason: `larger than ${MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024} MB` });
    } else {
      files.push({ path, size: info.size, executable: (info.mode & 0o111) !== 0 });
      totalBytes += info.size;
    }
  }
  if (files.length > MAX_SNAPSHOT_FILES) {
    throw new SnapshotError(
      `${files.length} files is more than the limit of ${MAX_SNAPSHOT_FILES}. Ignore generated files or work in a smaller repository.`,
    );
  }
  if (totalBytes > MAX_SNAPSHOT_BYTES * 3) {
    throw new SnapshotError(
      `The repository is ${(totalBytes / 1024 / 1024).toFixed(0)} MB, more than a snapshot can hold. Ignore generated files (build output, dependencies) or work in a smaller repository.`,
    );
  }

  return {
    root,
    branch: branch.trim() || null,
    baseCommit: head.trim() || null,
    remote: remote.trim() ? cleanRemote(remote) : null,
    files,
    totalBytes,
    excluded,
    dirty: parseStatus(status),
  };
}

/**
 * Reads one planned file the way the preview described it: a regular file (never a link that
 * appeared since), of the size that was shown. Anything else stops the upload, because what
 * would be sent is no longer what the owner approved.
 */
async function readPlanned(root: string, file: SnapshotFile): Promise<Buffer> {
  const path = join(root, file.path);
  const changed = (what: string): SnapshotError =>
    new SnapshotError(
      `${file.path} ${what} since the preview. Nothing was uploaded; run it again to see the new state.`,
    );
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw changed('is no longer a regular file');
  // O_NOFOLLOW (where the system has it) refuses a link swapped in after the check above.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw changed('is no longer a regular file');
    if (info.size !== file.size) throw changed('changed size');
    const data = await handle.readFile();
    if (data.length !== file.size) throw changed('changed size');
    return data;
  } finally {
    await handle.close();
  }
}

/** Reads the planned files and packs them. Files that vanish or cannot be read are reported. */
export async function buildArchive(plan: SnapshotPlan): Promise<{
  archive: Buffer;
  manifest: SnapshotManifest;
  unreadable: string[];
}> {
  const entries: ArchiveEntry[] = [];
  const unreadable: string[] = [];
  for (const file of plan.files) {
    let data: Buffer;
    try {
      data = await readPlanned(plan.root, file);
    } catch (error) {
      if (error instanceof SnapshotError) throw error;
      unreadable.push(file.path);
      continue;
    }
    entries.push({ path: file.path, data, executable: file.executable });
  }
  const archive = packTarGz(entries);
  if (archive.length > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError(
      `The compressed snapshot is ${(archive.length / 1024 / 1024).toFixed(0)} MB, over the ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB limit.`,
    );
  }
  const included = new Set(entries.map((e) => e.path));
  return {
    archive,
    unreadable,
    manifest: {
      fileCount: entries.length,
      baseCommit: plan.baseCommit,
      branch: plan.branch,
      dirtyFiles: plan.dirty
        .filter((d) => included.has(d.path))
        .map((d) => d.path)
        .slice(0, 10_000),
    },
  };
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The text shown before anything is uploaded. */
export function renderPreview(
  plan: SnapshotPlan,
  target: { host: string; project: string; profile: string },
  options: { listFiles?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const fileSet = new Set(plan.files.map((f) => f.path));
  const uploaded = plan.dirty.filter((d) => fileSet.has(d.path));
  lines.push(
    `Upload to ${target.host}  ·  project "${target.project}"  ·  permissions: ${target.profile}`,
  );
  lines.push('');
  lines.push(
    `  ${plan.files.length} files, ${size(plan.totalBytes)} (before compression) from ${plan.root}`,
  );
  lines.push(
    `  branch ${plan.branch ?? '(detached)'}  ·  base commit ${plan.baseCommit?.slice(0, 10) ?? '(none yet)'}${plan.remote ? `  ·  origin ${plan.remote}` : ''}`,
  );
  lines.push(
    '  Tracked files plus untracked files that git does not ignore. Ignored files are never uploaded.',
  );

  if (plan.dirty.length === 0) {
    lines.push('', '  Uncommitted changes: none. The upload matches the last commit.');
  } else {
    lines.push('', `  Uncommitted changes that WILL be uploaded (${uploaded.length}):`);
    for (const d of uploaded.slice(0, 40)) lines.push(`    ${d.kind.padEnd(10)} ${d.path}`);
    if (uploaded.length > 40) lines.push(`    … and ${uploaded.length - 40} more`);
    const notUploaded = plan.dirty.filter((d) => !fileSet.has(d.path));
    if (notUploaded.length > 0) {
      lines.push('', `  Changed but not uploaded (${notUploaded.length}):`);
      for (const d of notUploaded.slice(0, 20)) {
        const why =
          plan.excluded.find((e) => e.path === d.path)?.reason ??
          (d.kind === 'deleted' ? 'deleted locally' : 'not uploadable');
        lines.push(`    ${d.kind.padEnd(10)} ${d.path}  (${why})`);
      }
    }
  }

  if (plan.excluded.length > 0) {
    lines.push('', `  Left out (${plan.excluded.length}):`);
    for (const e of plan.excluded.slice(0, 30)) lines.push(`    ${e.path}  (${e.reason})`);
    if (plan.excluded.length > 30) lines.push(`    … and ${plan.excluded.length - 30} more`);
  }

  if (options.listFiles) {
    lines.push('', '  All files:');
    for (const f of plan.files) lines.push(`    ${size(f.size).padStart(9)}  ${f.path}`);
  }

  lines.push(
    '',
    '  The model reads these files while it works, so their contents are sent to the model provider',
    '  as part of the task, exactly as in a local Patch session. Nothing else leaves your machine.',
  );
  return lines;
}
