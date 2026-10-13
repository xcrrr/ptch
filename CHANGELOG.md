# Changelog

All notable changes to the `ptch` CLI. The hosted Patch Cloud service is deployed separately and is not covered here.

## Unreleased

- **`ptch` opens Patch Cloud.** The default view is a chat-first screen (the same idea as Patch HQ on the web): ask about your projects and runs, get a proposed run that you confirm before anything starts, follow runs, read the project's Brain. Slash commands: `/new`, `/resume`, `/projects`, `/runs`, `/run`, `/brain`, `/push`, `/login`, `/logout`, `/whoami`, `/help`, `/quit`. `ptch "<message>"` starts with a first message, `ptch --continue` and `ptch --resume [id]` reopen conversations, `PATCH_NO_BROWSER=1` shows the sign-in address instead of opening a browser, and `PATCH_SITE` picks the sign-in site.
- **The local interactive agent is switched off in this beta.** Print mode (`ptch -p`), which Patch Cloud's worker uses, is unchanged.
- **Patch Cloud client (private beta):** `ptch login` signs in through your browser (OAuth code flow with PKCE and a loopback redirect; the tokens are kept in the operating system's keystore where there is one), `ptch logout` signs the device out and revokes it, `ptch whoami` shows who and where.
- **Hand a task off:** `ptch cloud submit "<prompt>"` packs the repository (tracked files plus untracked files that are not ignored; secret-looking files such as `.env`, keys and credentials are left out, and so are symbolic links and oversized files), shows the file list and asks before anything is uploaded (`--dry-run` stops after the preview), then runs the task in an isolated environment. `ptch cloud list`, `show`, `logs --follow`, `cancel`, `retry`, `result` and `apply` follow it from the terminal; `apply` saves the result as a patch and applies it only if it fits cleanly.
- **Project memory:** `ptch cloud brain` lists, searches and adds entries to a project's Brain.
- **Start screen:** `ptch` opens on a clean screen with the animated `ptch` logo, which fades out when the first message or command is sent. Earlier terminal output is scrolled into history, not deleted.
- **Web search and web fetch** through Anthropic's server tools, on by default; turn them off with `PATCH_NO_WEB=1` or `"web"` in `~/.patch/config.json`, or limit them to chosen domains.
- **Images:** paste a screenshot with Alt+V (Ctrl+V where the terminal passes it through), drop an image file into the terminal, or mention `@path/to/image.png`; `read_file` returns images to the model.
- **Custom slash commands** from Markdown files in `.patch/commands/`, `.claude/commands/` and `~/.patch/commands/`, with `$ARGUMENTS` and `$1`–`$9`.
- **Hooks:** shell commands on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`, configured only in your user config; `/hooks` lists them.
- **Plan mode and permission modes:** Shift+Tab cycles default, accept-edits and plan mode; in plan mode Patch only researches and presents a plan for approval (`/plan`, `ptch --plan`).
- **Auto mode** (`/auto`, `ptch --auto`, or Shift+Tab after plan mode): no permission prompts, except that destructive commands and secret files still ask (in print mode they are denied); blocked commands, `.git` and deny rules never change. Turning it on asks for confirmation once per session.
- **MCP servers:** connect tools from Model Context Protocol servers (stdio or HTTP) configured in `~/.patch/config.json` or a project `.mcp.json`; project servers start only after you approve them, every call asks unless allowed (or in auto mode), and `/mcp` shows their status.
- **Workspace support** for organization-wide API keys (`ANTHROPIC_WORKSPACE_ID`), and clear messages for missing workspaces and an empty credit balance.
- **Claude Haiku 5.5** in the model list.
- Fixes: Git Bash commands are stopped reliably on interrupt and timeout even when another program's process breaks the MSYS process table; Windows short (8.3) paths and junctions no longer make project files look outside the project; interrupting a Git Bash command list can no longer start its next command; durations are no longer shown twice on tool rows.

## 0.1.0: first beta

The first working version of Patch, a terminal-first coding agent (`ptch`).

- Interactive terminal UI (React + Ink): streaming answers, concise tool rows with diffs, a multiline composer with history, slash-command autocomplete and `!` shell commands, Ctrl+C / Esc to interrupt.
- Agent loop with ten tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`, `bash`, `git_status`, `git_diff`, `git_log`.
- Permission system with read / write / execute classes, a shell command parser and risk classifier, conservative gates for running without asking and for session approvals, and persistent allow / deny rules.
- Sessions saved as append-only JSONL with `--continue`, `--resume` and `/resume`; basic context compaction with `/compact`.
- Project instructions from `PATCH.md` (with `CLAUDE.md` as a fallback), Git awareness, and a directory mode outside repositories.
- Non-interactive print mode (`ptch -p`) with exit codes and piped input.
- Anthropic provider on the official SDK: adaptive thinking with progress notes, prompt caching, streamed tool input, server-side refusal fallbacks.
- Slash commands: `/help`, `/status`, `/model`, `/permissions`, `/diff`, `/clear`, `/compact`, `/resume`, `/init`, `/exit`.
