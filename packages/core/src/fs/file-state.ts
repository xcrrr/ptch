export interface FileSnapshot {
  mtimeMs: number;
  size: number;
  /** sha1 hex of the file bytes. */
  hash: string;
}

export interface FileRecord {
  lastRead?: FileSnapshot;
  /** True when the last read covered only part of the file (offset/limit). */
  partialRead?: boolean;
  lastWrite?: FileSnapshot;
  /** Git state of the file before Patch first wrote to it in this session, if it had user changes. */
  preexistingChanges?: boolean;
}

/**
 * Tracks what Patch has read and written during a session so edits never clobber changes the
 * user made in the meantime. Keys are absolute paths (case-normalized on win32/darwin).
 */
export class FileStateTracker {
  private readonly records = new Map<string, FileRecord>();
  private readonly caseInsensitive: boolean;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.caseInsensitive = platform === 'win32' || platform === 'darwin';
  }

  private key(absolutePath: string): string {
    return this.caseInsensitive ? absolutePath.toLowerCase() : absolutePath;
  }

  get(absolutePath: string): FileRecord | undefined {
    return this.records.get(this.key(absolutePath));
  }

  recordRead(absolutePath: string, snapshot: FileSnapshot, partial: boolean): void {
    const record = this.records.get(this.key(absolutePath)) ?? {};
    // A partial read never downgrades a previous full read of the same content.
    const keepFull =
      partial && record.lastRead && !record.partialRead && record.lastRead.hash === snapshot.hash;
    record.lastRead = snapshot;
    record.partialRead = keepFull ? false : partial;
    this.records.set(this.key(absolutePath), record);
  }

  recordWrite(absolutePath: string, snapshot: FileSnapshot): void {
    const record = this.records.get(this.key(absolutePath)) ?? {};
    record.lastWrite = snapshot;
    // After Patch writes a file, Patch knows its full content.
    record.lastRead = snapshot;
    record.partialRead = false;
    this.records.set(this.key(absolutePath), record);
  }

  markPreexistingChanges(absolutePath: string): void {
    const record = this.records.get(this.key(absolutePath)) ?? {};
    record.preexistingChanges = true;
    this.records.set(this.key(absolutePath), record);
  }

  /** The most recent snapshot Patch knows (read or written). */
  lastKnown(absolutePath: string): FileSnapshot | undefined {
    return this.get(absolutePath)?.lastRead;
  }

  wasWrittenByPatch(absolutePath: string): boolean {
    return this.get(absolutePath)?.lastWrite !== undefined;
  }

  /** Absolute paths Patch has written this session (original casing not guaranteed on win32). */
  writtenFiles(): string[] {
    return [...this.records.entries()].filter(([, r]) => r.lastWrite).map(([k]) => k);
  }
}
