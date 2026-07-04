_English | [한국어](getting-started.ko.md)_

# Getting started

ADDE is a gateway that drives an AI CLI engine (Claude Code, etc.) remotely from a channel (Telegram / markdown notes). This document covers everything from installation to starting your first lane.

## Table of Contents

- [Requirements](#requirements)
- [Install](#install)
- [Core concepts](#core-concepts)
- [Lane configuration](#lane-configuration)
- [Start / stop](#start--stop)
- [Status and diagnostics](#status-and-diagnostics)
- [Project-folder mapping](#project-folder-mapping)
- [Uninstall](#uninstall)
- [Next steps](#next-steps)

## Requirements

- macOS (primary target)
- Node.js LTS (>=22) — the daemon is launched via launchd, so `node` must be on PATH (`adde up` injects the PATH at launch time into the plist).
- AI engine ACP adapter — `@zed-industries/claude-code-acp` is bundled with `adde` (no separate install needed).
- **Claude authentication**: the engine drives Claude Code through the bundled adapter, so **Claude must be authenticated under the same user account** (e.g. logged in via Claude Code, or `ANTHROPIC_API_KEY` set). If unauthenticated, the engine handshake fails and the lane will not start — first confirm that Claude works on its own.

## Install

**Global npm install** (the main command is `adde`):

```bash
npm i -g adde
```

The single entry point is `adde`. The short aliases (`ad`, `add`) are not installed by default; if you want them, opt in via `adde init` (the onboarding wizard) or `adde alias` — see the [command reference](commands.md#alias--install-short-aliases).

> **Permission error (EACCES)**: common on system/Homebrew Node (root-owned prefix). `sudo npm i -g` is not recommended (the package becomes root-owned, which breaks later updates). Use a version manager (nvm/fnm) or set a user prefix (`npm config set prefix ~/.local` and add `~/.local/bin` to PATH).
>
> **Running from source (development/contributing)**: after `pnpm install && pnpm build`, run `node dist/cli/adde.js ...`. `pnpm run dev` is for a tsx foreground run; the daemon (`adde up`) requires a build.

After installing, run `adde doctor` once to check prerequisites (Node version, ACP adapter, configuration) so you can catch gaps that would otherwise only surface at lane-startup time.

```bash
adde doctor        # global environment check, no project argument
```

### Update

```bash
npm i -g adde@latest       # update to the latest version
adde restart <proj>        # apply the new version to running lanes (restart required)
```

`npm i -g adde@latest` swaps the installed files, but **an already-running daemon still holds the old code in memory**, so you must restart it with `adde restart <proj>` for the new version to take effect. Pin a specific version with `npm i -g adde@<x.y.z>`. (`adde status` and `adde doctor` print a one-line notice when a newer version is available on npm.)

## Core concepts

- **Lane**: an independent vertical stack per `(channel source × backend × project folder)`. Input, approval, and output are all self-contained within the lane.
- **Source**: the channel that receives instructions. `telegram` (bot long-poll) or `markdown` (note-file watching, e.g. Obsidian).
- **Backend**: the AI-engine driving layer. Currently `acp` (Agent Client Protocol).
- **Gate**: routes every permission request to channel approval. Defaults to deny on timeout (default 10 minutes) or error (fail-closed). Tune approval frequency with tiers (`acp` default / `autopass` opt-in), allowlist, denylist, and hard-deny — for concepts and recommended settings, see the [permissions guide](permissions.md).

## Lane configuration

A lane is **one file = one lane**. Write it in `~/.config/adde/<proj>/lanes.d/<lane>.conf`.

### Fastest start — `adde init`

The fastest way to create your first lane is the onboarding wizard:

```bash
adde init [<proj>]
```

It first runs the global `doctor` and shows the results → asks whether to install the short aliases → prompts interactively for project/lane names and lane fields → creates the lane → prints the token-write and `adde up` start hints (TTY only). For a telegram lane the bot token is prompted last with **hidden input** (keystrokes not echoed) and written to `.env` (0600); leave it empty to set it later. Details: [command reference](commands.md#init--onboarding-wizard).

### Configure via subcommands

The `adde lane` subcommands create, list, and delete the conf file for you (direct editing also works).

```bash
# create a telegram lane (working folder, auto-allowed tools, reply target)
adde lane add myproj tg-claude --cwd /abs/project --allowlist Read,Grep --chat-id 12345

# read the telegram bot token from stdin and write it to state/<lane>/.env (0600)
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude --token-stdin

# create a markdown (note) lane
adde lane add myproj md-claude --source markdown --root /abs/Notes --inbox inbox.md

adde lane ls myproj                # list lanes
adde lane show myproj tg-claude    # print conf
adde lane rm myproj tg-claude      # delete conf
```

```bash
# interactive wizard — the default on a TTY when no field flags are given (the telegram token is prompted last, hidden)
adde lane add myproj tg-claude
adde lane add myproj tg-claude --interactive   # force the wizard; --no-interactive forces flags-only for scripts
```

On a TTY, `adde lane add <proj> <lane>` with **no field flags** launches the interactive wizard automatically; passing any field flag (or `--no-interactive`, or a non-TTY stdin) makes it non-interactive. The [command reference](commands.md#lane-add-options) table is authoritative for per-flag defaults and the full set of options (also available via `adde lane help`). An existing conf is not overwritten without `--force`. At creation time, a missing `cwd`, a missing markdown `root`, or a malformed token is reported as a warning (creation still proceeds).

### conf keys (when editing directly)

Common keys:

```ini
source=telegram         # telegram | markdown
backend=acp
engine=claude-code-acp  # ACP engine launch profile
channel=telegram        # for gate routing
perm_tier=acp
acp_version=v1
cwd=/abs/project/dir     # this lane's AI working folder (project-folder mapping)
allowlist=Read,Grep      # optional: reduce approval frequency (gate stays on)
```

Per-channel extra keys:

- **telegram**: `chat_id=<reply target>` (setting it also **auto-allows inbound from that chat**). The bot token goes not in the conf but in `~/.config/adde/<proj>/state/<lane>/.env` as `TELEGRAM_BOT_TOKEN=...` (never in arguments or logs). Inbound is processed only from allowed senders (`chat_id` ∪ `allow_from`); with none set, all inbound is denied (fail-closed) — authentication details: [telegram.md](telegram.md).
- **markdown**: `root=<absolute path, e.g. Obsidian vault>`, `inbox=<relative to root>`, and optionally `approvals=` / `outbox=`. → [markdown guide](markdown.md).

## Start / stop

```bash
adde up <proj>     # start all lanes in lanes.d as background daemons (macOS launchd) — returns immediately after registration
adde down <proj>   # stop the daemon (from any terminal)
adde restart <proj># restart the daemon (down + up)
adde --version
```

## Status and diagnostics

```bash
adde status <proj>            # show per-lane status (status value definitions: status section of the command reference)
adde status                   # no argument: aggregate running lanes across all projects (--all: include stopped)
adde doctor <proj>            # static check of environment/config (self-diagnosis before startup)
adde logs <proj> <lane>       # recent lane activity (transcript)
adde sessions <proj> <lane>   # engine session ledger list (resume/reset are channel commands)
```

**Success check**: if the lane shows `running` under `adde status <proj>`, startup succeeded. If it shows `stopped`/`dead`/`stale`, or if `adde up` failed, move on to [troubleshooting](troubleshooting.md).

If it won't start or doesn't respond, check with `adde doctor` first. For the full command set see the [command reference](commands.md); for remedies by symptom see [troubleshooting](troubleshooting.md).

## Project-folder mapping

Each lane's `cwd` is that lane's AI working directory. Assigning a different `cwd` per lane lets you **pair each channel/note with its own project folder** and run several at once. Keep several confs and one `adde up` starts them all.

## Uninstall

```bash
adde down <proj>       # 1) stop the daemon first — deregisters the launchd LaunchAgent
npm uninstall -g adde  # 2) remove the global package
```

**Order matters**: if you remove the package without `adde down`, the registered launchd LaunchAgent lingers and, even after a reboot, keeps trying to restart the (now-gone) executable. If you have several projects, run `adde down <proj>` for each (check registration status with `adde doctor <proj>`). Config/state files (`~/.config/adde/`) remain, so to remove everything, delete that directory after confirming.

## Next steps

- Drive it with a Telegram bot: [telegram.md](telegram.md)
- Note-based driving with markdown notes (e.g. Obsidian): [markdown.md](markdown.md)
- Understand the permission gate and tiers: [permissions.md](permissions.md)
- Full command set: [commands.md](commands.md)
- Troubleshooting: [troubleshooting.md](troubleshooting.md)
- Documentation index: [README.md](README.md)
