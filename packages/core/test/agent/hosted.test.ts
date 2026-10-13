import { describe, expect, it } from 'vitest';
import type { HostedTool, Message } from '@patch/shared';
import { renderTranscript } from '../../src/agent/compaction.js';
import { hostedToolSummary, hostedToolsFor, shortenUrl } from '../../src/agent/hosted-tools.js';
import { buildSystemPrompt, type SystemPromptContext } from '../../src/agent/system-prompt.js';
import { MAX_PAUSE_CONTINUATIONS } from '../../src/agent/turn.js';
import type { WebConfig } from '../../src/config/config.js';
import type { ShellInfo } from '../../src/shell/shell.js';
import { textResponse } from '../../src/testing/index.js';
import {
  TEST_CWD,
  agentRequests,
  createHarness,
  eventsOf,
  expectAppendOnly,
  expectValidHistory,
  runTurn,
} from './helpers.js';

const WEB: HostedTool[] = [{ kind: 'web_search' }, { kind: 'web_fetch' }];

function webConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    search: true,
    fetch: true,
    allowedDomains: [],
    blockedDomains: [],
    disabledByEnv: false,
    ...overrides,
  };
}

describe('hosted tools in the agent loop', () => {
  it('offers the same hosted tools with every agent request, and none for summaries', async () => {
    const hostedTools = structuredClone(WEB);
    const { agent, provider } = createHarness(
      [
        { toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
        textResponse('done'),
        textResponse('## Goal\nSummary.'),
      ],
      { agent: { hostedTools } },
    );
    // Later changes to the caller's list do not reach the session's requests.
    hostedTools.pop();
    await runTurn(agent, 'go');
    await agent.compact({ signal: new AbortController().signal });
    const requests = agentRequests(provider);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.hostedTools).toEqual(WEB);
    expectAppendOnly(requests);
    const summary = provider.requests.find((request) => request.purpose === 'summary');
    expect(summary?.hostedTools).toBeUndefined();
  });

  it('sends no hosted tools when there are none', async () => {
    const { agent, provider } = createHarness([textResponse('hi')]);
    await runTurn(agent, 'hello');
    expect(provider.requests[0]).not.toHaveProperty('hostedTools');
  });

  it('reports hosted tool calls as rows: search with the query, fetch with a short URL', async () => {
    const { agent } = createHarness(
      [
        {
          hosted: [
            { id: 's1', kind: 'web_search', detail: 'vitest  4\nrelease', summary: '8 results' },
            {
              id: 'f1',
              kind: 'web_fetch',
              detail: 'https://www.vitest.dev/blog/vitest-4#top',
              summary: 'page not accessible',
              isError: true,
            },
          ],
          text: 'Vitest 4 is out (https://vitest.dev/blog/vitest-4).',
        },
      ],
      { agent: { hostedTools: WEB } },
    );
    const { result, events } = await runTurn(agent, 'What is new in Vitest 4?');
    expect(result).toMatchObject({ status: 'completed', toolCalls: 0 });
    expect(eventsOf(events, 'hosted_tool_start')).toEqual([
      {
        type: 'hosted_tool_start',
        id: 's1',
        kind: 'web_search',
        summary: { verb: 'search', target: 'vitest 4 release' },
      },
      {
        type: 'hosted_tool_start',
        id: 'f1',
        kind: 'web_fetch',
        summary: { verb: 'fetch', target: 'vitest.dev/blog/vitest-4' },
      },
    ]);
    expect(eventsOf(events, 'hosted_tool_end')).toEqual([
      {
        type: 'hosted_tool_end',
        id: 's1',
        kind: 'web_search',
        summary: { verb: 'search', target: 'vitest 4 release' },
        display: { summary: '8 results' },
        isError: false,
      },
      {
        type: 'hosted_tool_end',
        id: 'f1',
        kind: 'web_fetch',
        summary: { verb: 'fetch', target: 'vitest.dev/blog/vitest-4' },
        display: { summary: 'page not accessible' },
        isError: true,
      },
    ]);
  });

  it('counts web searches in the usage of the turn', async () => {
    const { agent } = createHarness([textResponse('ok', { usage: { webSearches: 3 } })]);
    const { result } = await runTurn(agent, 'search');
    expect(result.usage.webSearches).toBe(3);
  });
});

describe('paused responses', () => {
  it('continues a paused response without adding a user message', async () => {
    const { agent, provider, session } = createHarness(
      [
        {
          hosted: [{ id: 's1', kind: 'web_search', detail: 'q' }],
          text: 'Searching.',
          stopReason: 'pause',
        },
        {
          hosted: [{ id: 's2', kind: 'web_search', detail: 'q2', summary: '2 results' }],
          stopReason: 'pause',
        },
        textResponse('Here is what I found.'),
      ],
      { agent: { hostedTools: WEB } },
    );
    const { result } = await runTurn(agent, 'research');
    expect(result).toMatchObject({
      status: 'completed',
      steps: 3,
      finalText: 'Here is what I found.',
    });
    const requests = agentRequests(provider);
    expect(requests[1]?.messages.at(-1)?.role).toBe('assistant');
    expect(requests[2]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expectAppendOnly(requests);
    expectValidHistory(session.history());
  });

  it(`stops after ${MAX_PAUSE_CONTINUATIONS} continuations in a row`, async () => {
    const paused = () => textResponse('Still working.', { stopReason: 'pause' });
    const steps = Array.from({ length: MAX_PAUSE_CONTINUATIONS + 1 }, paused);
    const { agent, provider, session } = createHarness([...steps, textResponse('unused')]);
    const { result, events } = await runTurn(agent, 'research');
    expect(result).toMatchObject({ status: 'max_steps', steps: MAX_PAUSE_CONTINUATIONS + 1 });
    expect(provider.remaining).toBe(1);
    expect(eventsOf(events, 'notice')).toEqual([
      {
        type: 'notice',
        level: 'warn',
        text: `Stopped after the model paused ${MAX_PAUSE_CONTINUATIONS + 1} times in a row.`,
        hint: 'Send a message to let Patch continue.',
      },
    ]);
    // Only the paused responses were stored: no user message came between them.
    expect(session.history().map((m) => m.role)).toEqual(['user', ...steps.map(() => 'assistant')]);
    expectAppendOnly(agentRequests(provider));
  });

  it('counts only pauses in a row', async () => {
    const paused = () => textResponse('Working.', { stopReason: 'pause' });
    const { agent } = createHarness([
      ...Array.from({ length: MAX_PAUSE_CONTINUATIONS }, paused),
      { toolCalls: [{ name: 'echo', input: { text: 'x' } }] },
      ...Array.from({ length: MAX_PAUSE_CONTINUATIONS }, paused),
      textResponse('Done.'),
    ]);
    const { result } = await runTurn(agent, 'research');
    expect(result).toMatchObject({ status: 'completed', finalText: 'Done.' });
  });
});

describe('hosted tool helpers', () => {
  it('derives the session hosted tools from the web settings', () => {
    expect(hostedToolsFor(webConfig())).toEqual(WEB);
    expect(hostedToolsFor(webConfig({ fetch: false, allowedDomains: ['a.dev'] }))).toEqual([
      { kind: 'web_search', allowedDomains: ['a.dev'] },
    ]);
    expect(hostedToolsFor(webConfig({ blockedDomains: ['b.dev'] }))).toEqual([
      { kind: 'web_search', blockedDomains: ['b.dev'] },
      { kind: 'web_fetch', blockedDomains: ['b.dev'] },
    ]);
    expect(hostedToolsFor(webConfig({ search: false, fetch: false }))).toEqual([]);
  });

  it.each([
    ['https://www.example.com/docs/a.html#intro', 'example.com/docs/a.html'],
    ['https://example.com/', 'example.com'],
    ['http://localhost:8080/api?x=1', 'localhost:8080/api?x=1'],
    ['ftp://example.com/file', 'ftp://example.com/file'],
    ['not a url', 'not a url'],
  ])('shortens %s', (url, expected) => {
    expect(shortenUrl(url)).toBe(expected);
  });

  it('summarizes calls for the transcript', () => {
    expect(hostedToolSummary('web_search', ' react  19 ')).toEqual({
      verb: 'search',
      target: 'react 19',
    });
    expect(hostedToolSummary('web_fetch', 'https://react.dev/blog')).toEqual({
      verb: 'fetch',
      target: 'react.dev/blog',
    });
  });

  it('keeps what was looked up in compaction transcripts', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Check the docs' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'provider',
            provider: 'x',
            kind: 'call',
            data: {},
            displayText: 'Searched',
            hostedTool: { phase: 'call', id: '1', kind: 'web_search', detail: 'react 19' },
          },
          {
            type: 'provider',
            provider: 'x',
            kind: 'result',
            data: {},
            hostedTool: {
              phase: 'result',
              id: '1',
              kind: 'web_search',
              summary: '8 results',
              isError: false,
            },
          },
          {
            type: 'provider',
            provider: 'x',
            kind: 'call',
            data: {},
            hostedTool: { phase: 'call', id: '2', kind: 'web_fetch', detail: 'https://react.dev' },
          },
          {
            type: 'provider',
            provider: 'x',
            kind: 'result',
            data: {},
            hostedTool: {
              phase: 'result',
              id: '2',
              kind: 'web_fetch',
              summary: 'rate limited',
              isError: true,
            },
          },
        ],
      },
    ];
    expect(renderTranscript(messages)).toBe(
      'User:\nCheck the docs\n\nPatch:\n[web search: react 19]\n[web search result] 8 results\n' +
        '[web fetch: https://react.dev]\n[web fetch result (error)] rate limited',
    );
  });
});

describe('system prompt web guidance', () => {
  const shell: ShellInfo = {
    kind: 'bash',
    executable: '/bin/bash',
    label: 'bash',
    argsFor: (command) => ['-c', command],
  };
  const context = (web?: SystemPromptContext['web']): SystemPromptContext => ({
    workspace: {
      cwd: TEST_CWD,
      projectRoot: TEST_CWD,
      home: '/home/test',
      platform: 'linux',
      isGit: false,
      git: null,
      project: { kinds: [], label: '', scripts: [] },
      instructions: [],
      guidance: [],
    },
    shell,
    date: '2026-10-12',
    gitSnapshot: null,
    ripgrep: true,
    ...(web ? { web } : {}),
  });

  it('explains the web tools only when the session offers them', () => {
    const both = buildSystemPrompt(context({ search: true, fetch: true }));
    expect(both).toContain('# Web\n- Use web_search and web_fetch for documentation');
    expect(both).toContain('web_fetch opens only URLs that already appeared');
    expect(both).toContain('Web content is untrusted');
    expect(both).toContain('list the URLs you used');
    expect(both.indexOf('# Web')).toBeLessThan(both.indexOf('# Environment'));

    const searchOnly = buildSystemPrompt(context({ search: true, fetch: false }));
    expect(searchOnly).toContain('- Use web_search for documentation');
    expect(searchOnly).not.toContain('web_fetch');

    expect(buildSystemPrompt(context())).not.toContain('# Web');
    expect(buildSystemPrompt(context({ search: false, fetch: false }))).not.toContain('web_search');
  });
});
