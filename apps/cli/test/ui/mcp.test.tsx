import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { McpApprovalPrompt, layoutMcpApproval } from '../../src/ui/components/McpApprovalPrompt.js';
import type { McpApprovalChoice, McpApprovalRequest } from '../../src/ui/components/props.js';
import { ToolRow, toolRowHeight } from '../../src/ui/components/ToolRow.js';
import { keys, plainLines, tick } from './helpers.js';

const request: McpApprovalRequest = {
  servers: [
    { name: 'github', target: 'npx -y @modelcontextprotocol/server-github' },
    { name: 'docs', target: 'https://docs.example.com/mcp' },
  ],
};

function prompt(props: { request?: McpApprovalRequest; maxRows?: number; width?: number } = {}) {
  const answers: McpApprovalChoice[] = [];
  const rendered = render(
    <McpApprovalPrompt
      request={props.request ?? request}
      onRespond={(choice) => answers.push(choice)}
      width={props.width ?? 80}
      {...(props.maxRows === undefined ? {} : { maxRows: props.maxRows })}
    />,
  );
  return { ...rendered, answers };
}

describe('McpApprovalPrompt', () => {
  it('lists each server with its command line or URL and the three choices', () => {
    const { lastFrame, unmount } = prompt();
    const lines = plainLines(lastFrame());
    unmount();
    expect(lines).toEqual([
      "  This project's .mcp.json wants to start 2 MCP servers",
      '',
      '    github  npx -y @modelcontextprotocol/server-github',
      '    docs    https://docs.example.com/mcp',
      '  MCP servers run with your privileges and receive what Patch sends them. Start',
      '  only servers you trust; Patch asks before each tool call.',
      '',
      '  › 1. Yes',
      '    2. Yes, and remember for this project',
      '    3. No',
      '  enter confirm · esc decline',
    ]);
    expect(layoutMcpApproval(request, 80).height).toBe(lines.length);
  });

  it('leaves servers out to fit the rows it has', () => {
    const many: McpApprovalRequest = {
      servers: Array.from({ length: 12 }, (_, i) => ({
        name: `s${i + 1}`,
        target: `cmd ${i + 1}`,
      })),
    };
    const layout = layoutMcpApproval(many, 80, 12);
    expect(layout.height).toBeLessThanOrEqual(12);
    expect(layout.hidden).toBe(12 - layout.rows.length);
    const { lastFrame, unmount } = prompt({ request: many, maxRows: 12 });
    const lines = plainLines(lastFrame());
    unmount();
    expect(lines).toHaveLength(layout.height);
    expect(lines).toContain(`    … ${layout.hidden} more servers`);
  });

  it('answers with the chosen option; esc declines', async () => {
    const remember = prompt();
    await tick();
    remember.stdin.write('2');
    await tick();
    expect(remember.answers).toEqual(['remember']);
    remember.unmount();

    const declined = prompt();
    await tick();
    declined.stdin.write(keys.escape);
    await tick(60);
    expect(declined.answers).toEqual(['no']);
    declined.unmount();
  });
});

describe('ToolRow for MCP tools', () => {
  it('puts the outcome of an MCP call on the second line', () => {
    const props = {
      name: 'mcp__github__create_issue',
      summary: { verb: 'mcp', target: 'github · create_issue', detail: 'title: "Fix login"' },
      status: 'done' as const,
      display: { summary: '3 lines' },
      width: 80,
    };
    const { lastFrame, unmount } = render(<ToolRow {...props} />);
    const lines = plainLines(lastFrame());
    unmount();
    expect(lines).toEqual([
      '  mcp     github · create_issue  title: "Fix login"',
      '          3 lines',
    ]);
    expect(toolRowHeight(props)).toBe(2);
  });
});
