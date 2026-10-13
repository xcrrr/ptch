import type { SessionEntry } from '@patch/core';
import type { ContentBlock, HostedToolActivity, Message } from '@patch/shared';
import { describe, expect, it } from 'vitest';
import { buildTranscriptFromEntries } from '../../src/app/transcript-builder.js';

const TS = '2026-10-12T10:00:00.000Z';

function entry(message: Message): SessionEntry {
  return { type: 'message', ts: TS, message };
}

function hosted(activity: HostedToolActivity): ContentBlock {
  return { type: 'provider', provider: 'anthropic', kind: 'block', data: {}, hostedTool: activity };
}

function build(messages: Message[]) {
  let next = 0;
  return buildTranscriptFromEntries(messages.map(entry), () => `i${++next}`).map(
    ({ id: _id, ...item }) => item,
  );
}

const user: Message = { role: 'user', content: [{ type: 'text', text: 'Research it.' }] };

describe('buildTranscriptFromEntries', () => {
  it('rebuilds hosted tool rows in place, with results from a later message', () => {
    const items = build([
      user,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Searching.' },
          hosted({ phase: 'call', id: 's1', kind: 'web_search', detail: 'vitest 4' }),
          hosted({ phase: 'call', id: 'f1', kind: 'web_fetch', detail: 'https://www.a.dev/x#y' }),
        ],
      },
      {
        role: 'assistant',
        content: [
          hosted({
            phase: 'result',
            id: 's1',
            kind: 'web_search',
            summary: '3 results',
            isError: false,
          }),
          hosted({ phase: 'call', id: 's2', kind: 'web_search', detail: 'never ran' }),
          { type: 'text', text: 'Done.' },
        ],
      },
    ]);
    expect(items).toEqual([
      { kind: 'user', text: 'Research it.' },
      { kind: 'assistant', markdown: 'Searching.', first: true },
      {
        kind: 'tool',
        name: 'web_search',
        summary: { verb: 'search', target: 'vitest 4' },
        status: 'done',
        display: { summary: '3 results' },
        first: true,
      },
      {
        kind: 'tool',
        name: 'web_fetch',
        summary: { verb: 'fetch', target: 'a.dev/x' },
        status: 'interrupted',
        first: false,
      },
      {
        kind: 'tool',
        name: 'web_search',
        summary: { verb: 'search', target: 'never ran' },
        status: 'interrupted',
        first: false,
      },
      { kind: 'assistant', markdown: 'Done.', first: true },
    ]);
  });

  it('joins cited passages with the text around them but keeps other runs apart', () => {
    const cited = { provider: 'anthropic', data: { citations: [{ url: 'https://a.dev' }] } };
    const items = build([
      user,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Based on the results, ' },
          { type: 'text', text: 'Vitest 4 is out', providerData: cited },
          { type: 'text', text: ' since October.' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'And?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First run.' },
          { type: 'text', text: 'Second run.' },
        ],
      },
    ]);
    expect(items.filter((item) => item.kind === 'assistant')).toEqual([
      {
        kind: 'assistant',
        markdown: 'Based on the results, Vitest 4 is out since October.',
        first: true,
      },
      { kind: 'assistant', markdown: 'First run.', first: true },
      { kind: 'assistant', markdown: 'Second run.', first: true },
    ]);
  });
});
