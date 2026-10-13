import path from 'node:path';

/**
 * Absolute path of a program in the Windows System32 directory, from %SystemRoot% (or %windir%,
 * else C:\Windows). Programs are always started by this path, never by bare name, which cmd.exe
 * would look up in the working directory first.
 */
export function system32Path(file: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', file);
}
