import { describe, expect, it } from 'vitest';
import { LiveTail } from '../../src/shell/live-tail.js';

describe('LiveTail', () => {
  it('keeps the last non-blank lines and counts every line', () => {
    const tail = new LiveTail(3);
    tail.push('one\ntwo\n\nthree\nfour\n');
    expect(tail.snapshot()).toEqual({ tail: ['two', 'three', 'four'], totalLines: 5 });
  });

  it('includes the unfinished current line', () => {
    const tail = new LiveTail(3);
    tail.push('done\ncompiling');
    expect(tail.snapshot()).toEqual({ tail: ['done', 'compiling'], totalLines: 2 });
    tail.push('... ok\n');
    expect(tail.snapshot()).toEqual({ tail: ['done', 'compiling... ok'], totalLines: 2 });
  });

  it('replaces the current line on carriage-return progress updates', () => {
    const tail = new LiveTail(5);
    tail.push('Downloading 10%');
    tail.push('\rDownloading 55%');
    expect(tail.snapshot().tail).toEqual(['Downloading 55%']);
    tail.push('\rDownloading 100%\r\nInstalled\r\n');
    expect(tail.snapshot()).toEqual({ tail: ['Downloading 100%', 'Installed'], totalLines: 2 });
  });

  it('never merges partial lines from stdout and stderr', () => {
    const tail = new LiveTail(5);
    tail.push('building', 'stdout');
    tail.push('warning: x\n', 'stderr');
    tail.push(' done\n', 'stdout');
    expect(tail.snapshot()).toEqual({ tail: ['warning: x', 'building done'], totalLines: 2 });
  });

  it('clips very long lines', () => {
    const tail = new LiveTail(1);
    tail.push(`${'x'.repeat(5000)}\n`);
    expect(tail.snapshot().tail[0]).toHaveLength(1000);
  });
});
