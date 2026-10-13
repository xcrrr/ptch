import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, noopLogger, type Logger } from '../../src/logging/logger.js';
import { makeTempDir } from '../../src/testing/fixtures.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const STAMP = '2026-10-07T12:00:00.000Z';

let temp: { dir: string; cleanup: () => void };
let logsDir: string;

beforeEach(() => {
  temp = makeTempDir();
  logsDir = join(temp.dir, 'home', 'logs');
});

afterEach(() => temp.cleanup());

function enabledLogger(now: () => Date = () => NOW): Logger {
  return createLogger({ enabled: true, dir: logsDir, now });
}

function logLines(logger: Logger): string[] {
  return readFileSync(logger.filePath!, 'utf8').split('\n').slice(0, -1);
}

/** The JSON data part of a log line (everything after the message). */
function dataOf(line: string, message: string): unknown {
  const marker = ` ${message} `;
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
}

describe('createLogger', () => {
  it('returns the no-op logger when disabled and touches nothing', () => {
    const logger = createLogger({ enabled: false, dir: logsDir });
    expect(logger).toBe(noopLogger);
    expect(logger.enabled).toBe(false);
    expect(logger.filePath).toBeUndefined();
    logger.error('ignored', { a: 1 });
    expect(logger.child('x')).toBe(noopLogger);
    expect(existsSync(logsDir)).toBe(false);
  });

  it('writes one formatted line per entry to a dated file, creating the directory', () => {
    const logger = enabledLogger();
    expect(logger.enabled).toBe(true);
    expect(logger.filePath).toBe(join(logsDir, 'patch-2026-10-07.log'));

    logger.debug('starting', { model: 'm', steps: 2 });
    logger.info('plain message');
    logger.warn('careful', null);
    logger.error('failed', 'text data');

    expect(logLines(logger)).toEqual([
      `${STAMP} DEBUG starting {"model":"m","steps":2}`,
      `${STAMP} INFO plain message`,
      `${STAMP} WARN careful null`,
      `${STAMP} ERROR failed "text data"`,
    ]);
  });

  it('appends to an existing log file', () => {
    enabledLogger().info('first process');
    enabledLogger().info('second process');
    expect(logLines(enabledLogger())).toEqual([
      `${STAMP} INFO first process`,
      `${STAMP} INFO second process`,
    ]);
  });

  it('stamps each line with the time it was written', () => {
    let current = NOW;
    const logger = enabledLogger(() => current);
    logger.info('one');
    current = new Date('2026-10-07T12:00:01.500Z');
    logger.info('two');
    expect(logLines(logger)).toEqual([`${STAMP} INFO one`, '2026-10-07T12:00:01.500Z INFO two']);
  });

  it('prefixes scopes for children and shares the file', () => {
    const logger = enabledLogger();
    const agent = logger.child('agent');
    const tools = agent.child('tools');
    agent.info('turn started');
    tools.debug('running', { tool: 'read' });
    logger.info('root again');

    expect(agent.filePath).toBe(logger.filePath);
    expect(logLines(logger)).toEqual([
      `${STAMP} INFO [agent] turn started`,
      `${STAMP} DEBUG [agent] [tools] running {"tool":"read"}`,
      `${STAMP} INFO root again`,
    ]);
  });

  it('keeps every entry on one line', () => {
    const logger = enabledLogger();
    logger.child('multi\nline').warn('first\nsecond\r\nthird', { text: 'a\nb' });
    expect(logLines(logger)).toEqual([
      `${STAMP} WARN [multi\\nline] first\\nsecond\\r\\nthird {"text":"a\\nb"}`,
    ]);
  });

  it.skipIf(process.platform === 'win32')('keeps logs private', () => {
    const logger = enabledLogger();
    logger.info('x');
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
    expect(statSync(logger.filePath!).mode & 0o777).toBe(0o600);
  });
});

describe('log data serialization', () => {
  it('serializes errors with name, message, stack, own fields and cause', () => {
    const logger = enabledLogger();
    const cause = new TypeError('inner');
    const error = Object.assign(new Error('outer', { cause }), { code: 'E_TEST', status: 500 });
    logger.error('boom', { error });

    const data = dataOf(logLines(logger)[0]!, 'boom') as { error: Record<string, unknown> };
    expect(data.error).toMatchObject({
      name: 'Error',
      message: 'outer',
      code: 'E_TEST',
      status: 500,
    });
    expect(data.error.stack).toEqual(expect.stringContaining('outer'));
    expect(data.error.cause).toMatchObject({ name: 'TypeError', message: 'inner' });
  });

  it('marks circular references but not repeated ones', () => {
    const logger = enabledLogger();
    const shared = { value: 1 };
    const node: Record<string, unknown> = { name: 'root', left: shared, right: shared };
    node.self = node;
    logger.debug('graph', node);

    expect(dataOf(logLines(logger)[0]!, 'graph')).toEqual({
      name: 'root',
      left: { value: 1 },
      right: { value: 1 },
      self: '[Circular]',
    });
  });

  it('handles bigints, dates, maps, sets, buffers, functions and undefined fields', () => {
    const logger = enabledLogger();
    logger.debug('values', {
      big: 12345678901234567890n,
      when: new Date('2026-01-02T03:04:05.000Z'),
      map: new Map([['k', 1]]),
      set: new Set(['a']),
      bytes: Buffer.from('hello'),
      fn: function namedFn() {},
      missing: undefined,
      list: [1, undefined],
    });

    expect(dataOf(logLines(logger)[0]!, 'values')).toEqual({
      big: '12345678901234567890',
      when: '2026-01-02T03:04:05.000Z',
      map: [['k', 1]],
      set: ['a'],
      bytes: '[Buffer 5 bytes]',
      fn: '[Function namedFn]',
      list: [1, null],
    });
  });

  it('truncates long strings to 10k characters with a marker', () => {
    const logger = enabledLogger();
    logger.debug('long', { output: 'x'.repeat(25_000) });
    const data = dataOf(logLines(logger)[0]!, 'long') as { output: string };
    expect(data.output).toBe(`${'x'.repeat(10_000)}… [15000 more chars]`);
  });

  it('summarizes very deep structures', () => {
    const logger = enabledLogger();
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    logger.debug('deep', deep);
    expect(logLines(logger)[0]).toContain('"[Object]"');
  });

  it('isolates properties whose getters throw', () => {
    const logger = enabledLogger();
    const hostile = {
      ok: 1,
      get bad(): never {
        throw new Error('getter exploded');
      },
    };
    logger.debug('hostile', hostile);
    expect(dataOf(logLines(logger)[0]!, 'hostile')).toEqual({ ok: 1, bad: '[Unserializable]' });
  });
});

describe('logger redaction', () => {
  it('redacts secrets in messages and data', () => {
    const logger = enabledLogger().child('provider');
    logger.debug('using key sk-ant-api03-AAAAbbbbCCCCdddd1234', {
      headers: { 'x-api-key': 'sk-ant-api03-ZZZZ', authorization: 'Bearer abc.def.ghi' },
      apiKey: 'plain-secret-value',
      body: '{"password":"hunter2"}',
      model: 'claude-opus-5-5',
    });

    const [line] = logLines(logger);
    expect(line).not.toMatch(/AAAAbbbb|ZZZZ|abc\.def|plain-secret|hunter2/);
    expect(line).toContain('using key [REDACTED]');
    expect(line).toContain('"model":"claude-opus-5-5"');
    expect(line).toContain('"apiKey":"[REDACTED]"');
    expect(line).toContain('\\"password\\":\\"[REDACTED]\\"');
  });
});

describe('logger robustness', () => {
  it('never throws when the log directory cannot be created', () => {
    writeFileSync(join(temp.dir, 'home'), 'a file where the directory should be');
    const logger = enabledLogger();
    expect(() => logger.info('lost', { a: 1 })).not.toThrow();
    expect(() => logger.child('x').error('lost too')).not.toThrow();
  });

  it('never throws when the clock fails', () => {
    let calls = 0;
    const logger = enabledLogger(() => {
      calls++;
      if (calls > 1) throw new Error('clock broke');
      return NOW;
    });
    expect(() => logger.info('x')).not.toThrow();
  });

  it('recreates the directory if it is removed while running', () => {
    const logger = enabledLogger();
    logger.info('before');
    temp.cleanup();
    logger.info('after');
    expect(logLines(logger)).toEqual([`${STAMP} INFO after`]);
  });
});
