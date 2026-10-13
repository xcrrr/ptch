import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageBlock } from '@patch/shared';
import { Session, SessionStore } from '../../src/session/store.js';
import { makeTempDir, pngBytes } from '../../src/testing/index.js';
import { fullMeta, newMeta, userBlocks, writeSessionFile } from './helpers.js';

const IMAGE: ImageBlock = {
  type: 'image',
  mediaType: 'image/png',
  data: pngBytes(16, 9).toString('base64'),
  label: 'screenshot.png',
};

let temp: { dir: string; cleanup: () => void };
let sessionsDir: string;
let store: SessionStore;

beforeEach(() => {
  temp = makeTempDir();
  sessionsDir = join(temp.dir, 'sessions');
  store = new SessionStore(sessionsDir);
});

afterEach(() => temp.cleanup());

describe('images in session files', () => {
  it('round-trip inline in user messages and tool results', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userBlocks([IMAGE, { type: 'text', text: 'What is in [Image #1]?' }]));
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.png' } }],
      },
    });
    session.append(
      userBlocks([
        {
          type: 'tool_result',
          toolCallId: 'c1',
          content: 'Image: a.png (16×9, 70 B)',
          images: [{ ...IMAGE, label: 'a.png' }],
        },
      ]),
    );

    // The image data is in the file itself (base64), so the session replays without the files.
    expect(readFileSync(session.filePath, 'utf8')).toContain(IMAGE.data);
    const loaded = store.load(session.id);
    expect(loaded).toBeInstanceOf(Session);
    expect(loaded.entries()).toEqual(session.entries());
    expect(loaded.history()).toEqual(session.history());
    expect(JSON.stringify(loaded.history())).toBe(JSON.stringify(session.history()));
    expect(loaded.title()).toBe('What is in [Image #1]?');
  });

  it('round-trip next to web search blocks and cited text', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userBlocks([IMAGE, { type: 'text', text: 'Is this the documented layout?' }]));
    session.append({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'provider',
            provider: 'anthropic',
            kind: 'server_tool_use',
            data: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
            hostedTool: { phase: 'call', id: 's1', kind: 'web_search', detail: 'q' },
          },
          {
            type: 'text',
            text: 'Yes.',
            providerData: {
              provider: 'anthropic',
              data: { citations: [{ url: 'https://a.dev' }] },
            },
          },
        ],
      },
    });
    session.append(
      userBlocks([
        { ...IMAGE, label: 'second.png' },
        { type: 'text', text: 'And?' },
      ]),
    );

    const loaded = store.load(session.id);
    expect(loaded.history()).toEqual(session.history());
    expect(JSON.stringify(loaded.history())).toBe(JSON.stringify(session.history()));
  });

  it('load from sessions written before images existed', () => {
    const id = '01d5e551-0000-4000-8000-000000000001';
    const ts = '2026-09-01T00:00:00.000Z';
    // Lines exactly as Patch 0.1.0 wrote them: tool results carry text only.
    writeSessionFile(sessionsDir, id, [
      fullMeta(id, temp.dir),
      {
        type: 'message',
        ts,
        message: { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      },
      {
        type: 'message',
        ts,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } }],
        },
      },
      {
        type: 'message',
        ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'c1', content: 'const a = 1;' }],
        },
      },
    ]);

    const loaded = store.load(id);
    expect(loaded.history()).toHaveLength(3);
    expect(loaded.history()[2]!.content).toEqual([
      { type: 'tool_result', toolCallId: 'c1', content: 'const a = 1;' },
    ]);
  });

  it('skip messages whose images are malformed', () => {
    const id = '01d5e551-0000-4000-8000-000000000002';
    const ts = '2026-09-01T00:00:00.000Z';
    const message = (content: unknown[]) => ({
      type: 'message',
      ts,
      message: { role: 'user', content },
    });
    writeSessionFile(sessionsDir, id, [
      fullMeta(id, temp.dir),
      message([{ type: 'image', mediaType: 'image/bmp', data: 'Qk0=' }]),
      message([{ type: 'image', mediaType: 'image/png' }]),
      message([{ type: 'tool_result', toolCallId: 'c1', content: 'x', images: 'nope' }]),
      message([IMAGE, { type: 'text', text: 'kept' }]),
    ]);

    const loaded = store.load(id);
    expect(loaded.history()).toEqual([
      { role: 'user', content: [IMAGE, { type: 'text', text: 'kept' }] },
    ]);
  });

  it('do not get in the way of session listings', () => {
    const session = store.create(newMeta(temp.dir));
    session.append(userBlocks([IMAGE, { type: 'text', text: 'Fix the layout in this shot' }]));
    const listed = store.list({ projectRoot: temp.dir });
    expect(listed.map((summary) => summary.title)).toEqual(['Fix the layout in this shot']);
  });
});
