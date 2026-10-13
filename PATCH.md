# Patch: working in this repository

Patch is an open-source coding agent and the `ptch` command-line client for Patch Cloud. TypeScript, Node 20+, pnpm workspaces.

## Commands

- Install: `pnpm install`
- Build the CLI: `pnpm build` (tsup bundles `apps/cli/src/main.ts` to `apps/cli/dist/main.js`)
- All tests: `pnpm test` · one file: `pnpm vitest run --project unit packages/core/test/agent/agent.test.ts`
- Typecheck: `pnpm typecheck` · Lint: `pnpm lint` · Format: `pnpm format`
- Everything CI checks: `pnpm check`
- Real-API smoke tests (needs a key): `PATCH_INTEGRATION=1 pnpm test:integration`
- Pack the built CLI for a release: `pnpm pack:cli` (writes `release/ptch-<version>.tgz` and `release/SHA256SUMS`)

## Layout

- `packages/shared`: provider-neutral model protocol (`ModelProvider`, `Message`, `ModelEvent`) and text utilities. No vendor code here.
- `packages/core`: agent runtime: `agent/` (loop, compaction, system prompt), `tools/` (first-party tools), `permissions/` (command risk + decisions), `session/` (JSONL store), `git/`, `workspace/`, `fs/` (path policy, file IO), `shell/`, `config/`, `logging/`.
- `packages/provider-anthropic`: `AnthropicProvider` on the official SDK, plus a conformance-checking mock API server in `src/testing/`.
- `packages/cloud-protocol`: the Patch Cloud API as the client sees it: zod schemas and types for tasks, events, projects, the Brain, workspace snapshots, and the rules for which files may be uploaded.
- `apps/cli`: `ptch`: args, runtime bootstrap, print mode, the Patch Cloud client (`src/cloud/`: sign-in, workspace upload, task commands) and the Ink UI (`src/app/` controller + view, `src/ui/` components).

Internal packages export TypeScript source (`exports: ./src/index.ts`); only the CLI is built, and it bundles them.

## Conventions

- ESM with `.js` extensions in relative imports; strict TypeScript; Prettier (single quotes, 100 columns).
- Core never imports a provider SDK. Providers only depend on `@patch/shared`.
- The CLI talks to Patch Cloud only through `@patch/cloud-protocol` and HTTP. Nothing in this repository may depend on how the hosted service is deployed, and no host, token or credential may be written into the sources, tests or docs. Tests use fake hosts (`example.com`) and obviously fake tokens.
- Conversation history is append-only: never edit, merge or drop earlier messages, and never rebuild the session's system prompt or tool list mid-session (prompt caching and preserved reasoning depend on a stable prefix).
- Tools describe calls (`summarize`, `permission`, `preview`) and execute them; only `PermissionManager` decides. Expected tool failures throw `ToolError` with a message written for the model.
- UI uses named ANSI colors from `apps/cli/src/ui/theme.ts` only; secondary information is dim.
- Tests live in each package's `test/` directory and must pass on Windows and POSIX.
