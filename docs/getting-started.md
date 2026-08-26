_English | [한국어](getting-started.ko.md)_

# Getting started

ADDE is a gateway that drives an AI CLI engine (Claude Code, etc.) from your markdown notes, accumulating every conversation as searchable, linked notes in a vault you own. This document covers install through your first project and session.

## Table of Contents

- [Requirements](#requirements)
- [Install](#install)
- [Core concepts](#core-concepts)
- [Create a project](#create-a-project)
- [Create a session](#create-a-session)
- [Start / stop](#start--stop)
- [Status and diagnostics](#status-and-diagnostics)
- [Uninstall](#uninstall)
- [Next steps](#next-steps)

## Requirements

- macOS (primary target — daemon control depends on launchd)
- Node.js LTS (>=22) on PATH
- AI engine ACP adapter (bundled with `adde`)
- **Claude authentication**: the engine drives Claude Code through the bundled adapter, so Claude must be authenticated under the same user account (logged in via Claude Code, or `ANTHROPIC_API_KEY` set). Confirm Claude works on its own before troubleshooting ADDE.

## Install

```bash
npm i -g adde-acp
```

The single entry point is `adde`. Short aliases (`ad`, `add`) are opt-in — via `adde init` or `adde alias` (see [command reference](commands.md#alias--install-short-aliases)).

> **Permission error (EACCES)**: use a version manager (nvm/fnm) or a user npm prefix instead of `sudo npm i -g` (root-owned installs break later updates).
>
> **Running from source (development)**: `pnpm install && pnpm build`, then `node dist/cli/adde.js ...`. The daemon (`adde up`) requires a build — `pnpm run dev` is for a foreground tsx run only.

Run `adde doctor` once after installing:

```bash
adde doctor        # global environment check, no project argument
```

### Update

```bash
npm i -g adde-acp@latest
adde restart <proj>   # the daemon holds old code in memory until restarted
```

`adde status`/`adde doctor` print a one-line notice when a newer version is available.

## Core concepts

- **Project**: a top-level unit — a vault root (required) and optionally a working directory. Holds any number of sessions.
- **Session**: one conversation. Has its own id, engine, and lifecycle state — `active` (engine resident) / `hibernated` (engine not resident, resumes on the next turn) / `detached` (resume failed or gave up self-recovery) / `archived` (superseded or explicitly ended).
- **Binding**: the link between a channel address (e.g. a markdown note path) and a session. A Surface only knows the binding, never the session's internals.
- **Vault**: the markdown storage root you specify — where every conversation accumulates as linked notes (turn/session/project). The only original data is the conversation event record inside it; notes, attachments-by-reference, and dedup results are all regenerable (`adde vault rebuild`).
- **Engine**: the AI CLI driving layer, currently ACP-only (`claude-agent-acp`, registered as engine id `acp`).
- **Gate**: routes every permission request to channel approval, fail-closed on timeout/error. See the [permissions guide](permissions.md).

Two independence axes run through the whole design: a **channel** (markdown; Telegram/Discord not implemented yet) never sees a session's internals, and an **engine** is driven only through its declared capabilities (`EngineCaps`) — the core never branches on which engine it is.

## Create a project

```bash
adde project add myproj --vault ~/ObsidianVault --cwd /Users/me/work/my-project
```

`--vault` is **required** — ADDE never invents a default storage location (this is deliberate: your conversation history is data you own, and where it lives is your choice, not a hidden default). `--cwd` is the folder the engine works in for this project (optional).

For a guided walkthrough (including permission-tier choice), use the onboarding wizard instead:

```bash
adde init [<proj>]
```

See the [command reference](commands.md#project--manage-projects) for the full `project add` option table (permission tier, allowlist/denylist/hard-deny, retention/backup, sync provider).

```bash
adde project ls                    # list projects
adde project show myproj           # print settings
adde project set myproj perm_tier autopass --add-deny "Bash(sudo *)"
```

## Create a session

```bash
adde session new myproj --title "frontend work"
```

Each session gets its own conversation history, engine resume handle, and (for the markdown surface) an input note under `<vault>/adde/projects/myproj/sessions/<sid>/inbox.md`. The note appears within a couple of seconds while the project's daemon is running (see [Start / stop](#start--stop) below) — if the daemon isn't running yet, it appears once you start it. You send instructions by editing that note — see the [markdown guide](markdown.md) for the full palette/compose/records layout.

```bash
adde session ls myproj             # list sessions
adde session show myproj <sid>     # session details
adde session clear myproj <sid>    # succession — new session, old one archived (not deleted)
```

## Start / stop

```bash
adde up <proj>       # start the project's daemon (macOS launchd) — returns immediately after registration
adde down <proj>     # stop the daemon (from any terminal)
adde restart <proj>  # restart the daemon — required after a project-conf change
```

One daemon process per project hosts every session. On boot, every session that was `active` auto-resumes using its stored engine resume handle.

## Status and diagnostics

```bash
adde status <proj>            # per-session status table
adde status                   # no argument: aggregate every project
adde doctor <proj>            # static check of environment/config
adde logs <proj> <sid>        # recent session activity (conversation event record)
```

**Success check**: if a session shows `active` (or `hibernated` — expected once idle) under `adde status <proj>`, the daemon and that session are healthy. `detached` means it needs attention — see [troubleshooting](troubleshooting.md).

## Uninstall

```bash
adde down <proj>              # 1) stop the daemon first — deregisters the launchd LaunchAgent
npm uninstall -g adde-acp     # 2) remove the global package
```

Repeat `adde down <proj>` for each project before uninstalling (check with `adde doctor <proj>`), or a lingering launchd registration will keep trying to restart the now-missing executable. Config/settings (`~/.config/adde/`) remain after uninstall — delete that directory to remove everything. **Your vault (conversation history) is never touched by uninstall** — it's ordinary markdown files at the path you chose.

## Next steps

- Drive it from markdown notes (e.g. Obsidian): [markdown.md](markdown.md)
- Understand the permission gate and tiers: [permissions.md](permissions.md)
- Full command set: [commands.md](commands.md)
- Troubleshooting: [troubleshooting.md](troubleshooting.md)
- Documentation index: [README.md](README.md)
