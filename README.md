<!-- Language: **English** | [한국어](README.ko.md) -->

# ADDE — Ai Driven Development Engine

_English | [한국어](README.ko.md)_

> ⚠️ **Status: early development.** ACP backend + Telegram/Markdown source adapters work (a PoC vertical slice). The API may change.

ADDE is a gateway that drives an **AI CLI** (Claude Code / Codex, etc.) remotely from a **channel** (Telegram / Markdown notes such as Obsidian; Discord on hold). The AI does the development work while you instruct, approve, and observe from chat.

## When to use it

- When you want to **instruct a per-project AI, approve its tool use, and check results** from your phone (Telegram) or notes (Obsidian) while away from the keyboard.
- When you want to run several projects **concurrently**, each bound to its own working directory (a "lane").
- When you want a **human approval gate** (fail-closed by default) on every tool execution.

> ⚠️ **Data-flow warning**: your instructions, code, and the AI's replies pass through the AI engine provider (ACP → Claude/Codex, etc.) and the channel infrastructure (Telegram). With the Markdown source, approval/output notes are **replicated by your syncing vault** (Obsidian Sync, iCloud, etc.) — for sensitive projects, read [Markdown guide — exposure of sensitive data](docs/markdown.md#syncing-vaults-and-exposure-of-sensitive-data) first.

## Quick start

```sh
npm i -g adde-acp     # global install
adde init         # guided setup (environment check + short alias + first lane)
```

`adde init` walks you through `doctor` (environment check) → installing short aliases (`ad`/`add`, opt-in) → creating a lane interactively. For manual setup, see [Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md) — install, lane config, startup, status/diagnostics, project-folder mapping
- [Telegram guide](docs/telegram.md) — bot creation, token, step-by-step startup
- [Markdown guide](docs/markdown.md) — drive the AI from notes (e.g. Obsidian): instructions, replies, approvals
- [Permissions guide](docs/permissions.md) — the gate, tiers (acp/autopass), allowlist/denylist, hard-deny, recommended settings
- [Command reference](docs/commands.md) · [Troubleshooting](docs/troubleshooting.md)

## Core design

- **ACP-first**: the engine runs as a headless [Agent Client Protocol](https://agentclientprotocol.com) subprocess and ADDE drives it as an ACP client. Instructions, replies, permissions, logs, and usage all flow through a single event stream (no terminal scraping).
- **Engine-agnostic**: `claude-agent-acp` and `codex-acp` speak the same protocol, so a single backend adapter drives multiple engines.
- **Lane isolation**: each `(source × backend × project)` is an independent vertical stack. Input, approvals, and output are self-contained within a lane.
- **Fail-closed permissions**: every permission request is routed to the channel for approval, defaulting to deny on timeout/error. Per-lane opt-ins are also available: an `autopass` tier (auto-allow everything except the denylist, fully recorded) and a tier-independent **hard-deny** (`--safe-defaults` blocks sudo, rm -rf, credential reads, etc. as defense-in-depth).
- **i18n (en/ko)**: CLI output and channel messages support English and Korean. Locale is auto-detected (`ADDE_LANG` > system locale `LC_ALL`/`LC_MESSAGES`/`LANG` > default en), with a per-lane channel language (`lane add --lang`). See "Language (locale)" in the [command reference](docs/commands.md).

## Commands

```sh
adde init [<proj>]           # guided setup (doctor + short alias + create a lane)
adde up <proj>               # start all lanes of the project as a background daemon (macOS launchd)
adde down <proj>             # stop the daemon — works from any terminal
adde restart <proj>          # restart the daemon (down + up)
adde status [<proj>] [--all] [--json]  # lane status (all running projects if <proj> omitted, --all includes stopped)
adde doctor [<proj>]         # static environment/config checks (incl. daemon registration + file permissions)
adde logs <proj> <lane> [N] [--engine]  # last N lines of the lane transcript (or engine stderr with --engine)
adde sessions <proj> <lane>  # list engine sessions (resume/clear via channel commands — see commands.md)
adde lane add <proj> <lane>  # create a lane conf (options: --source/--cwd/--chat-id/--root/--safe-defaults/--interactive …)
adde lane ls <proj>          # list lanes
adde lane show <proj> <lane> # print a lane conf
adde lane rm <proj> <lane>   # delete a lane conf
adde alias [names...]        # install short aliases (ad, add) next to the adde binary
adde completion <bash|zsh>   # print a shell completion script
```

For lane configuration details see [Getting started](docs/getting-started.md#lane-configuration); for the full command set see the [command reference](docs/commands.md).

## Install / runtime

- Install: **global npm install** `npm i -g adde-acp`. Update with `npm i -g adde-acp@latest` then `adde restart <proj>` (`status`/`doctor` notify you of a new version). For development/contribution, build from source (`pnpm install && pnpm build`). Details and permission (EACCES) notes: [Getting started](docs/getting-started.md#install).
- The short aliases `ad`/`add` are **not** installed automatically — opt in via `adde init` or `adde alias` (avoids clashing with common global command names).
- TypeScript + Node.js LTS (>=22)
- **An AI engine ACP adapter is required** (e.g. `@agentclientprotocol/claude-agent-acp`) — `adde doctor` checks for it up front.
- macOS is the primary target — `adde up`/`down`/`restart` are built on macOS launchd LaunchAgents, with auto-recovery after reboot/logout. Linux/WSL are out of scope for now.

## Status / roadmap

- [x] Design (ACP-first redesign complete)
- [x] Dev environment scaffold (TypeScript · pnpm · CI)
- [x] PoC (ACP spike · permission routing)
- [~] MVP: `markdown | telegram → claude(ACP)` vertical slice (source adapters + per-lane project-folder mapping working)
- [ ] Codex backend · Discord (on hold) · non-ACP CLI scraping (on hold)

## License / security

- License: [MIT](LICENSE)
- Report security vulnerabilities: [SECURITY.md](SECURITY.md)

---

<sub>Predecessor project: [cctg](https://qwertygeon.github.io/cctg/) (Claude Code Tmux Gateway). ADDE is the successor that removes cctg's dependency on `claude --channels` and is redesigned around ACP.</sub>
