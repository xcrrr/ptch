/** Error code of a Node.js system error, if any. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** True for errors meaning "this path does not exist" (including a file used as a directory). */
export function isMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const FS_ERROR_TEXT: Record<string, string> = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EROFS: 'the file system is read-only',
  ENOSPC: 'no space left on device',
  EDQUOT: 'disk quota exceeded',
  EISDIR: 'it is a directory',
  ENOTDIR: 'a parent path is not a directory',
  EEXIST: 'a parent path is not a directory',
  ENOENT: 'no such file or directory',
  EBUSY: 'the file is locked by another process',
  ENAMETOOLONG: 'the path is too long',
  ELOOP: 'too many levels of symbolic links',
  EMFILE: 'too many open files',
  EINVAL: 'the path is not valid on this system',
};

/**
 * Short, human description of a file system error ("permission denied"), without stack traces or
 * the raw syscall details Node puts into messages.
 */
export function describeFsError(error: unknown): string {
  const code = errorCode(error);
  if (code && FS_ERROR_TEXT[code]) return FS_ERROR_TEXT[code];
  if (error instanceof Error && error.message) return error.message;
  return 'unknown error';
}
