<!-- Language: **English** | [한국어](README.ko.md) -->

# ADDE — Ai Driven Development Engine

_English | [한국어](README.ko.md)_

[![npm](https://img.shields.io/npm/v/adde-acp)](https://www.npmjs.com/package/adde-acp)
[![CI](https://github.com/qwertygeon/adde/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertygeon/adde/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/adde-acp)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/adde-acp)](LICENSE)

> ⚠️ **Status: early development.** The v2 core (project/session/binding model, ACP engine driver, markdown channel) works; Telegram/Discord are registered but not implemented (stub) in this release. The API may change.

ADDE is a gateway that drives an **AI CLI** (Claude Code, etc.) from a **channel** (Markdown notes such as Obsidian today; Telegram/Discord not implemented yet), accumulating every conversation as searchable, linked notes in a vault you own. The AI does the development work while you instruct, approve, and observe from your notes.

## When to use it

- When you want **every AI conversation for a project to accumulate as your own markdown notes** — turn-by-turn, cross-linked, searchable, syncable with whatever tool you already use.
- When you want to **instruct a per-project AI, approve its tool use, and check results** from your notes while away from the keyboard.
- When you want to run **several independent conversations (sessions)** against the same or different project folders concurrently.
- When you want a **human approval gate** (fail-closed by default) on every tool execution.

> ⚠️ **Data-flow warning**: your instructions, code, and the AI's replies pass through the AI engine provider (ACP → Claude, etc.). Approval/turn notes are **replicated by your syncing vault** (Obsidian Sync, iCloud, etc.) — for sensitive projects, read [Markdown guide — sensitive data and vault placement](docs/markdown.md#sensitive-data-and-vault-placement) first.
>
> ℹ️ **Unofficial tool.** ADDE is an unofficial, third-party tool not built or endorsed by Anthropic or any engine/channel provider. "Claude" and "Claude Code" are trademarks of Anthropic; other engine and platform names are trademarks of their respective owners. This project is not affiliated with any of them.
>
> 📜 **Your use is subject to upstream terms.** Driving an AI engine sends your content to that engine's provider (e.g. the Anthropic API for Claude), so your use is governed by your own plan terms and usage policies. See [SECURITY.md → Your responsibilities as an operator](SECURITY.md#your-responsibilities-as-an-operator).

## Quick start

```sh
npm i -g adde-acp     # global install
adde init             # guided setup (environment check + short alias + first project)
```

`adde init` walks you through `doctor` (environment check) → installing short aliases (`ad`/`add`, opt-in) → creating your first project (vault path + permission settings) interactively. For manual setup, see [Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md) — install, core concepts, first project & session, status/diagnostics
- [Markdown guide](docs/markdown.md) — drive the AI from notes (e.g. Obsidian): palette, instructions, turn notes, approvals
- [Permissions guide](docs/permissions.md) — the gate, tiers (acp/autopass), allowlist/denylist, hard-deny, recommended settings
- [Command reference](docs/commands.md) · [Troubleshooting](docs/troubleshooting.md) · [Telegram/Discord status](docs/telegram.md) (not implemented)

## Core design

- **ACP-first**: the engine runs as a headless [Agent Client Protocol](https://agentclientprotocol.com) subprocess and ADDE drives it as an ACP client. Instructions, replies, permissions, logs, and usage all flow through a single event stream (no terminal scraping).
- **Engine-agnostic**: engines are driven only through a declared `EngineCaps` capability set behind a registry (`ENGINE_REGISTRY`) — the core never branches on which engine it is. Currently one engine is registered (`acp`, driving `claude-agent-acp`).
- **Channel-agnostic**: a `Surface` (channel adapter) only knows the binding between a channel address and a session, never the session's internals. Currently `markdown` is implemented; `telegram`/`discord` are registered but stub.
- **Lossless record, regenerable notes**: every turn's every event is appended to a conversation event record that is never deleted or overwritten (crash-safe, size-generation split instead). Notes (turn/session/project) are pure projections of that record — delete or corrupt them and `adde vault rebuild` regenerates them exactly.
- **A session you're done with stops being watched**: a session can be `stopped` — by hand, from the note palette, or automatically after an hour of inactivity — and from then on its input note and approval directory are not read on any cycle. You bring it back by picking it from an active session's note or with `adde session resume`. Everything the session ever did stays in the vault.
- **Session-owned storage**: each session owns its own event record, attachment store and duplicate-detection ledger, so removing a session completely is a directory deletion rather than a reference count — and can never take content another session still points at.
- **Fail-closed permissions**: every permission request is routed to channel approval, defaulting to deny on timeout/error. Project-level opt-ins are also available: an `autopass` tier (auto-allow everything except the denylist, fully recorded) and a tier-independent **hard-deny** (`--safe-defaults` blocks sudo, rm -rf, credential reads, etc. as defense-in-depth).
- **i18n (en/ko)**: CLI output and channel messages support English and Korean. Locale is auto-detected (`ADDE_LANG` > system locale `LC_ALL`/`LC_MESSAGES`/`LANG` > default en), with a per-project channel language (`project set <proj> lang <en|ko>`). See "Language (locale)" in the [command reference](docs/commands.md).

## Commands

```sh
adde init [<proj>]                     # guided setup (doctor + short alias + create a project)
adde up <proj> [--json]                # start all sessions of the project as a background daemon (macOS launchd)
adde down <proj> [--json]              # stop the daemon — works from any terminal
adde restart <proj> [--json]           # restart the daemon (down + up)
adde status [<proj>] [--all] [--json]  # session status (all projects if <proj> omitted, --all includes stopped/detached)
adde doctor [<proj>] [--json]          # static environment/config checks
adde logs <proj> <session> [N] [--engine] [-f]  # session event log (or engine diagnostic log with --engine)
adde project <add|set|show|ls|rm>      # manage projects (vault path, permission tier, retention, ...)
adde session <new|ls|show|clear|stop|resume|rm>  # manage sessions (one per conversation)
adde bind <add|rm|ls>                  # manage channel↔session bindings
adde vault <rebuild>                   # regenerate notes/dedup ledger from the event record
adde factory-reset                     # wipe ALL projects and sessions (irreversible, interactive-only)
adde alias [names...]                  # install short aliases (ad, add) next to the adde binary
adde completion <bash|zsh>             # print a shell completion script
```

For core concepts see [Getting started](docs/getting-started.md#core-concepts); for the full command set see the [command reference](docs/commands.md).

## Install / runtime

- Install: **global npm install** `npm i -g adde-acp`. Update with `npm i -g adde-acp@latest` then `adde restart <proj>` (`status`/`doctor` notify you of a new version). For development/contribution, build from source (`pnpm install && pnpm build`). Details and permission (EACCES) notes: [Getting started](docs/getting-started.md#install).
- The short aliases `ad`/`add` are **not** installed automatically — opt in via `adde init` or `adde alias` (avoids clashing with common global command names).
- TypeScript + Node.js LTS (>=22)
- **An AI engine ACP adapter is required** (e.g. `@agentclientprotocol/claude-agent-acp`) — `adde doctor` checks for it up front.
- macOS is the primary target — `adde up`/`down`/`restart` are built on macOS launchd LaunchAgents, with auto-recovery after reboot/logout and automatic session resume. Linux/WSL are out of scope for now.

## Status / roadmap

- [x] v0.2.x: `markdown | telegram → claude(ACP)` lane-based vertical slice
- [x] v2 core: project/session/binding model, lossless record store, `EngineDriver`/`Surface` registries, markdown channel (grouped palette, warning/notice zones), auto-resume/hibernate/stop, self-recovery
- [ ] Telegram/Discord channel implementation (currently stub) · additional engine drivers · non-ACP CLI scraping (on hold)

## License / security / meta

- License: [MIT](LICENSE)
- Report security vulnerabilities: [SECURITY.md](SECURITY.md)
- Project meta: [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

---

<sub>Predecessor project: [cctg](https://qwertygeon.github.io/cctg/) (Claude Code Tmux Gateway). ADDE is the successor that removes cctg's dependency on `claude --channels` and is redesigned around ACP.</sub>
