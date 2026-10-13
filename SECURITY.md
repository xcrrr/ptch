# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include the Patch version (`ptch --version`) or commit, your OS and shell, and the smallest command, prompt or repository that reproduces the problem.

You can expect an acknowledgement within a few days. Fixes land on `main`; there are no maintained release branches during the beta, so please test against the latest commit.

If a report involves a credential of yours (an API key, a Patch Cloud token), revoke it first and then send the report; never put a live secret in a report.

## Scope

This repository is the `ptch` command-line client, the agent runtime it embeds, and the client side of the Patch Cloud API. In scope:

**Permissions and the local machine** (wherever the agent runs a language model's tool calls with your privileges, for example `ptch -p` or the local view kept behind a development switch, the permission system is a security boundary):

- A shell command that runs without asking but can write files, reach the network, or run arbitrary code (for example through an option, environment variable or syntax the classifier misreads).
- A session approval ("don't ask again") that covers more than the command the user approved.
- File tools reading or writing outside the project root without asking, including through symlinks, junctions, short names or `..`.
- Writes inside `.git/`, reads of secret files (`.env`, keys, credentials) without asking, or secrets appearing in debug logs or session files.
- Any path to privilege escalation (`sudo` and similar must never run).
- A repository (instruction files, custom commands, `.mcp.json`) making Patch run something without the user's approval.

**The Patch Cloud client** (`ptch login`, `ptch cloud ...`):

- Tokens leaking: written to disk in readable form where the platform offers a keystore, printed, logged, or sent to a host other than the one the user signed in to.
- Sign-in flow flaws in the client: the loopback redirect, PKCE handling, accepting an endpoint it should refuse (for example plain HTTP to a public host).
- The workspace upload including files it promises to leave out (secret-looking files by name, ignored files, paths that escape the repository), or the preview showing something different from what is uploaded.
- Applying a task's result patch outside the working tree, or in a way that overwrites changes the user did not see.

## Out of scope

- Commands you approve, or rules you add to `~/.patch/config.json` (`bash:*` allows everything by design), and commands you type yourself with `!`.
- Code and command output being sent to the model provider, and to Patch Cloud when you upload a workspace: that is how Patch works, and the README describes it.
- Weaknesses of the hosted Patch Cloud service itself, which is not in this repository. If you find one while testing the client, report it the same way and we will route it.
- Findings that need an attacker who already controls your user account or your terminal.
- Denial of service by a model producing a huge output, or a hostile repository being slow to scan.

## Design notes

How the permission system works is described in the README under [Permissions](README.md#permissions) and [Privacy and security](README.md#privacy-and-security). Patch does not sandbox commands on your machine; the permission prompts are the safeguard, and anything the classifier is not sure about asks.
