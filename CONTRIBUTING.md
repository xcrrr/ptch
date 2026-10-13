# Contributing to Patch

Thanks for helping. Patch is small enough that a good issue or a focused pull request makes a difference. There is no contributor agreement to sign; by opening a pull request you agree that your change is released under the [MIT license](LICENSE) like the rest of the project.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

You need Node.js 20.19 or newer, pnpm 9 and Git. If you don't have pnpm, `corepack enable` (bundled with Node) or `npm install -g pnpm@9` gets it.

```bash
git clone https://github.com/xcrrr/ptch.git
cd ptch
pnpm install
pnpm build
pnpm setup            # once per machine: puts pnpm's global bin directory on PATH (open a new terminal afterwards)
pnpm link --global    # makes `ptch` run this checkout
```

`ptch` now runs the code in your checkout, so a rebuild is all it takes to try a change. `pnpm dev` rebuilds on every save.

## Updating

```bash
git pull
pnpm install
pnpm build
```

The linked `ptch` picks up the new build; there is nothing to reinstall.

## Making a change

1. Open an issue first for anything larger than a fix, so we can agree on the direction before you spend time on it.
2. Create a branch: `git switch -c my-change`.
3. Make the change, with tests next to the code you touch (each package has a `test/` directory).
4. Run `pnpm check`: typecheck, lint, format check, unit tests and build. This is what CI runs on Linux and Windows.
5. If you changed the terminal UI or the agent loop, run the end-to-end scenarios too:

   ```bash
   pnpm build
   pnpm -C apps/cli exec tsx scripts/e2e/run.ts
   ```

6. Push your branch and open a pull request. Describe what changed, why, and how you tested it. Keep it focused: one change per pull request is easier to review and easier to revert.

`pnpm format` fixes formatting. One test file: `pnpm vitest run --project unit path/to/file.test.ts`.

The README windows are rendered from the same harness against the mock API: `pnpm build && pnpm -C apps/cli screenshots`. The logo lives in `apps/cli/src/ui/logo.ts`; `pnpm -C apps/cli logo` plays its animation in your terminal and `pnpm -C apps/cli logo --svg` rewrites the README logo images.

The local agent UI of the first beta is switched off in the beta build. To work on it, run it with the development switch `PATCH_ENABLE_LOCAL=1` (see [docs/local-agent.md](docs/local-agent.md#working-on-the-local-view)); print mode (`ptch -p`) never needs it.

## Tests without an API key or an account

Unit and end-to-end tests never call the real Anthropic API and never talk to Patch Cloud. They use a scripted model provider, a local mock of the Anthropic Messages API (`packages/provider-anthropic/src/testing/`) that also checks request conformance, and injected `fetch` functions for the Patch Cloud client. You do not need a Patch Cloud invitation to work on this repository. Real-API smoke tests are opt-in and cost a few cents:

```bash
ANTHROPIC_API_KEY=sk-ant-... PATCH_INTEGRATION=1 pnpm test:integration
```

## Code layout and conventions

[PATCH.md](PATCH.md) describes the layout and the rules the code follows (it is also what Patch itself reads when working on this repository). The short version:

- `packages/shared`: provider-neutral protocol and utilities.
- `packages/core`: agent loop, tools, permissions, sessions. Never imports a provider SDK.
- `packages/provider-anthropic`: the Anthropic provider and the mock API server.
- `packages/cloud-protocol`: the types and schemas of the Patch Cloud API, as the client sees them.
- `apps/cli`: the `ptch` command, its Patch Cloud client (`src/cloud/`), the cloud view that `ptch` opens (`src/cloudview/`) and the Ink components it shares with the older local agent UI (`src/app/`, `src/ui/`).

Changes to the permission system (`packages/core/src/permissions/`) need tests for both the case you allow and the bypasses you considered; see `strict-gate.test.ts` for the style. When in doubt, ask instead of allowing.

Changes to what the Patch Cloud client uploads (`apps/cli/src/cloud/snapshot.ts`, `packages/cloud-protocol/src/secrets.ts`) need tests too, and must keep the rule that the user sees the file list before anything leaves the machine.

Style: TypeScript with strict settings, ESM with `.js` extensions in relative imports, Prettier (single quotes, 100 columns; `pnpm format`), no `any` unless a comment says why.

## Reporting bugs and asking for features

Use the issue templates. A bug report is most useful with the version (`ptch --version`), your OS and terminal, the smallest steps that reproduce it, and, for agent behavior, the debug log (`ptch --debug`; secrets are redacted, but look before you paste).

## Releases

Maintainers cut releases as described in [docs/RELEASING.md](docs/RELEASING.md).
