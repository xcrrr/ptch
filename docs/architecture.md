# Architecture

```
apps/cli                 ptch: argument parsing, runtime bootstrap, print mode, the cloud view
  src/cloud/             Patch Cloud client: sign-in (PKCE), keystore, workspace snapshot,
                         task commands, project memory
  src/cloudview/         the cloud view (what `ptch` opens): conversation, proposals, runs, Brain
  src/app/, src/ui/      Ink components and the agent UI used by the development switch
packages/core            agent runtime (no provider code)
  agent/                 the loop, system prompt, compaction
  tools/                 read_file, edit_file, write_file, list_directory, glob, grep,
                         bash, git_status, git_diff, git_log, present_plan
  permissions/           shell parser, command risk classifier, PermissionManager
  session/               append-only JSONL session store
  hooks/ commands/       user hooks and custom slash commands
  mcp/                   MCP servers: configuration, approvals, connections, tools
  git/ workspace/ fs/ shell/ config/ logging/
packages/cloud-protocol  the Patch Cloud API as the client sees it: schemas, types, upload rules
packages/provider-anthropic   AnthropicProvider (official SDK) + mock API server for tests
packages/shared          provider-neutral protocol and utilities
```

The agent loop depends only on the `ModelProvider` interface from `@patch/shared`:

```ts
interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  getModelInfo(model: string): ModelInfo;
  listModels(): ModelInfo[];
}
```

A request carries the frozen session system prompt, the conversation in a provider-neutral format (text, tool calls, tool results, and opaque provider blocks that are echoed back verbatim), and tool specs. Events stream back (`text_delta`, `tool_call_start`, `progress`, …) and end with the complete assistant message. A new provider is a package that implements this interface; the loop, tools, permissions, sessions and UI are unchanged.

The loop: send the conversation, stream text and tool calls, check each call with the permission manager, run tools (independent reads run concurrently), append all results in one message, and repeat until the model answers without tool calls. History is append-only, which keeps prompt caching effective and preserves the model's reasoning across tool calls.

The client talks to Patch Cloud over HTTPS using the schemas in `@patch/cloud-protocol`; it knows nothing about how the service is deployed.

Internal packages export their TypeScript source; only `apps/cli` is built (tsup), bundling the internal packages. Publishing to npm is not set up; the package name is a placeholder.
