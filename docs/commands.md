_English | [한국어](commands.ko.md)_

# Command reference

The full command and option set of the ADDE CLI (v2). The single main entry point is `adde`. The short aliases (`ad`, `add`) are not installed by default; opt in via `adde init` or `adde alias`.

> **v0.2.x commands removed**: `lane`, `sessions`, `proj` are no longer valid top-level commands. Running one prints a "removed — use …" notice (with the replacement command) and exits with code 2, instead of failing silently. See [Migration from v0.2.x](#migration-from-v02x).

## Table of Contents

- [Global options](#global-options)
- [Concepts recap](#concepts-recap)
- [init — onboarding wizard](#init--onboarding-wizard)
- [alias — install short aliases](#alias--install-short-aliases)
- [up / down / restart — daemon control](#up--down--restart--daemon-control)
- [status — session status](#status--session-status)
- [doctor — environment check](#doctor--environment-check)
- [logs — session event log](#logs--session-event-log)
- [project — manage projects](#project--manage-projects)
- [session — manage sessions](#session--manage-sessions)
- [bind — manage channel bindings](#bind--manage-channel-bindings)
- [vault — vault maintenance](#vault--vault-maintenance)
- [Session control (markdown palette)](#session-control-markdown-palette)
- [completion — shell completion](#completion--shell-completion)
- [Help and typo hints](#help-and-typo-hints)
- [Exit codes](#exit-codes)
- [Language (locale)](#language-locale)
- [Paths](#paths)
- [macOS-only features](#macos-only-features)
- [Migration from v0.2.x](#migration-from-v02x)

## Global options

| Option            | Description   |
| ----------------- | ------------- |
| `-v`, `--version` | Print version |
| `-h`, `--help`    | Print help    |

Running `adde` with no arguments, or `-h`/`--help`/`help`, prints the overall usage. For a specific command's help, `adde <command> --help` (e.g. `adde status --help`, `adde project --help` for all `project` subcommand options).

**Machine-readable output (`--json`)**: commands that support `--json` print a single JSON document on stdout with a top-level schema-version field `v` (currently `1`).

## Concepts recap

- **Project**: a top-level unit with a vault root and (optionally) a working directory. Holds N sessions.
- **Session**: a unit of conversation with its own id, engine, and lifecycle state (`active` / `hibernated` / `detached` / `archived`).
- **Binding**: the link between a channel address (e.g. a markdown input note path) and a session.
- **Vault**: the markdown storage root where conversations accumulate as notes (required at project creation).

See [Getting started](getting-started.md#core-concepts) for the full model.

## init — onboarding wizard

```bash
adde init [<proj>]
```

An interactive onboarding wizard (**TTY only**) that runs `doctor`, offers to install the short aliases, offers shell tab-completion setup, then prompts for a project name and its required `--vault` path (and, optionally, working directory and permission settings) to create the first project. It ends with a hint to start the daemon (`adde up <proj>`).

## alias — install short aliases

```bash
adde alias [names...]
```

Installs short-alias symlinks next to the `adde` executable found in PATH (default `ad`, `add`). An existing command with the same name is skipped (not overwritten) and reported as a failure. Idempotent — a symlink already pointing at `adde` is reported as already set.

## up / down / restart — daemon control

```bash
adde up <proj> [--json]
adde down <proj> [--json]
adde restart <proj> [--json]
```

Starts/stops/restarts **one daemon process per project** (not per session) as a **macOS launchd LaunchAgent**. All of a project's sessions live inside that single daemon process; `up` boots the daemon and **auto-resumes every session that was `active`** using its stored engine resume handle (a session that fails to resume is marked `detached` with the reason recorded, not silently replaced by a new session).

- **Terminal-independent**: the daemon keeps running after you close the terminal.
- **Crash-only auto-restart**: launchd restarts the daemon on a crash, throttled to at most once every 60 seconds, and always relaunches it after a macOS reboot/logout (`RunAtLoad`). A deliberate stop (`adde down`) or a deterministic boot failure exits cleanly and is not auto-retried. Editable with the project's `auto_restart` key (`adde project set <proj> auto_restart false`); see [crash safety](troubleshooting.md#crash-safety--log-rotation).
- **`restart`** performs `down` then `up` and, since the daemon holds the current code in memory, is how you apply both a new `adde` version and a `project set` conf change.
- **Startup result**: after registering, `up`/`restart` wait for the daemon to record a boot report and print a summary (`N running · M failed`) — a session that failed to start is listed with its reason and the command exits non-zero. The wait window can be extended on slow machines via the `ADDE_UP_WAIT_MS` env var (milliseconds, default `8000`; only a **positive** integer is honored — non-numeric, zero, or negative values fall back to the default silently).
- **Startup notices**: non-blocking, not-meant-to-be-resolved notices about the boot itself (currently: an `autopass`-tier banner naming the effective denylist) print to stderr right before the summary line. They're also carried in the boot report's `notices` field, so `--json` output includes them (additive field — schema version unchanged).
- **`--json`**: prints the boot outcome instead of the plain-text summary (schema documented in [`status`](#status--session-status) below — `up`/`restart` report the same per-session shape).
- **macOS only** — see [macOS-only features](#macos-only-features).

```bash
adde up myproj --json      # machine-readable boot outcome
adde restart myproj        # apply a project-conf change or a new adde version
```

## status — session status

```bash
adde status [<proj>] [--all] [--json]
```

| Status       | Meaning                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `active`     | Engine process resident, session ready to receive turns                                                                  |
| `hibernated` | Session alive, engine process not resident (idle timeout or resident-count cap) — resumes transparently on the next turn |
| `detached`   | Resume failed, or the engine gave up self-recovery after repeated crashes — reason recorded                              |
| `archived`   | Preserved, no longer active (created by `session clear`'s succession or `session rm` without `--purge`)                  |

- **With `<proj>`**: table `SID · STATUS · ENGINE · PRESENT · WARN · TITLE · LAST_ACTIVITY`.
- **Without `<proj>`**: aggregates every registered project, table `PROJECT · SID · STATUS · ENGINE · PRESENT · WARN · LAST_ACTIVITY`.
- **`WARN`**: number of warnings recorded on the session (`-` when none) — storage failures, resume failures, and the like. The text itself is not shown here; read it with `session show <proj> <session>`.
- **`--all`**: include `archived` sessions (omitted by default).
- **`--json`**: `{ "v": 1, "sessions": [...], "halt": ... }` — `halt` carries the crash-loop self-halt record (`HaltRecord | null` for a single `<proj>` view, or a per-project map for the aggregated view). See [crash safety & log rotation](troubleshooting.md#crash-safety--log-rotation).
- If a session is `detached`, or the daemon has self-halted after a crash loop, a warning with remedy guidance is printed to stderr and `status` exits non-zero.
- Read-only.

```bash
adde status myproj            # per-session table for one project
adde status --all             # every project, including archived sessions
adde status myproj --json     # machine-readable {v, sessions, halt}
```

## doctor — environment check

```bash
adde doctor [<proj>] [--json]
```

Static checks independent of runtime state, each reported `PASS` / `WARN` / `FAIL` / `INFO` with a remedy hint on failure/warning.

- **Global**: Node version (≥22) · registered engine drivers (`ENGINE_REGISTRY`) · registered surfaces (`SURFACE_REGISTRY`, including `telegram`/`discord` shown as stub) · (macOS) daemon entry file resolution · OS check (`FAIL` off macOS — macOS is the only supported target).
- **v0.2.x data presence** (`INFO`): if a legacy `~/.config/adde/<proj>/lanes.d/` layout is found, it is reported for awareness only — never read or modified. A name collision where a v0.2.x project was itself named `projects` is reported as `FAIL` with an explanation (v2 reserves that name as its project container) — no v0.2.x data is touched either way.
- **Crash-loop self-halt** (`FAIL`, with `<proj>`): if the project's daemon has self-halted, reported with a pointer to `adde up`/`adde restart` to clear it.
- With `<proj>`: launchd registration cross-check (plist vs. `launchctl`) · `project.conf` readability · configured engine validity · vault path existence (vault is created on first use if missing — `WARN`, not `FAIL`).
- **`--json`**: `{ "v": 1, "checks": [...] }`. Suppresses the summary line and the update notice.
- Exit code: `FAIL` present → 1, otherwise 0.

```bash
adde doctor myproj --json   # machine-readable check list (CI/monitoring)
```

## logs — session event log

```bash
adde logs <proj> <session> [N] [--engine] [--daemon] [-f|--follow] [--json]
```

Prints a human-readable rendering of the session's **conversation event record** (`.adde/sessions/<sid>/events-NNNN.jsonl` in the vault) — the last `N` lines (default 50).

- `N`: trailing line count (default 50); a non-positive/non-numeric value falls back to 50 with a warning.
- `--engine`: prints the session's **engine diagnostic log** instead (`runtime/sessions/<sid>/engine.log` under the config root — size-based rotation allowed, unlike the event record which is never rotated or deleted).
- `--daemon`: prints the project's **launchd daemon log** — `<session>` is not needed for this form.
- `-f`/`--follow`: live-tail (like `tail -f`), following log rotation/truncation transparently; `Ctrl-C` to stop. Not supported with `--daemon`.
- `--json`: `{ "v": 1, "proj", "sid", "path", "exists", "lines" }` snapshot (takes priority over `--follow`).

```bash
adde logs myproj a1b2c3d4 100 --engine   # last 100 lines of the engine diagnostic log
adde logs myproj --daemon                 # daemon log (why the daemon/a session failed to boot)
adde logs myproj a1b2c3d4 -f              # live-tail the conversation event record
```

## project — manage projects

```bash
adde project add <proj> --vault <path> [options]              # create (vault path required)
adde project set <proj> <key> <value>... [--unset <key>...]   # edit settings
adde project show <proj> [key] [--json] [--defaults]          # show settings
adde project ls [--json]                                      # list projects
adde project rm <proj> --force                                 # delete (config root only — vault data preserved)
```

Creating a project **requires `--vault <path>`** — ADDE never invents a default storage location. `--cwd` is the working directory the engine operates in for this project's sessions (optional — omit it to have the engine work relative to its own process cwd).

### `project add` options

| Option                            | Default                                | Description                                                                                                 |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--vault <path>`                  | (required)                             | Markdown vault root                                                                                         |
| `--cwd <path>`                    | (none)                                 | Engine working directory                                                                                    |
| `--engine <id>`                   | `acp`                                  | Registered engine driver id (see `adde doctor` for the list)                                                |
| `--perm-tier <acp\|autopass>`     | `acp`                                  | Permission tier — see [permissions guide](permissions.md)                                                   |
| `--allowlist <a,b,c>`             | (none)                                 | Auto-allowed tools under `acp`                                                                              |
| `--denylist <entries,...>`        | built-in default list, `autopass` only | Tools/patterns that fall back to channel approval under `autopass`                                          |
| `--hard-deny <entries,...>`       | (none)                                 | Tools/patterns refused outright, any tier                                                                   |
| `--safe-defaults`                 | —                                      | Seed hard-deny with the built-in danger list (union with explicit `--hard-deny`)                            |
| `--backup <path>`                 | (none)                                 | Retention (archive) destination — see [markdown guide](markdown.md#keeping-the-vault-light-retention--sync) |
| `--retention-days <n>`            | `2`                                    | Turn-note age (days) before retention moves it                                                              |
| `--sync-provider <local\|icloud>` | `local`                                | Vault sync provider — `icloud` waits for a not-yet-downloaded file before retention moves it                |

If `--perm-tier autopass` is chosen without `--denylist`, ADDE seeds the built-in default denylist and prints a notice:

```
autopass 티어에 거부 목록이 지정되지 않아 내장 기본 거부 목록 <N>건을 시드했습니다.
```

### `project set` — edit settings

```bash
adde project set <proj> <key> <value>...              # positional dot-notation edits, one or more pairs
adde project set <proj> --unset <key>...               # remove keys (restore their default)
adde project set <proj> --add-allow <a,b,c> --rm-deny <x,y>   # incremental list edits
```

Editable keys (single definition — `adde project set`/`show`/completion all derive from it):

`cwd`, `engine`, `engine_args`, `perm_tier`, `allowlist`, `denylist`, `hard_deny`, `gate_timeout_sec`, `lang`, `file_mode`, `auto_restart`, `auto_resume`, `idle_hibernate`, `hibernate_after_min`, `max_active_engines`, `auto_relaunch`, `markdown.palette`, `markdown.records_cap`, `vault.backup`, `vault.retention_days`, `vault.sync_provider`.

`vault` itself is not editable (identity field, set once at `project add`). A batch of edits is **all-or-nothing** — an unknown key or an invalid value rejects the whole command and writes nothing.

**Incremental list edits**: `--add-allow`/`--rm-allow`, `--add-deny`/`--rm-deny`, `--add-hard-deny`/`--rm-hard-deny` merge into or subtract from the current list instead of replacing it (the positional `allowlist`/`denylist`/`hard_deny <value>` form replaces the whole list). Applying an edit requires `adde restart <proj>` — the daemon only loads project settings at startup.

### `project show` / `project ls` / `project rm`

```bash
adde project show myproj                       # full settings dump
adde project show myproj perm_tier --json      # one key's value/default/explicit
adde project show myproj --defaults             # every editable key and its built-in default
adde project ls --json                          # { v, projects: [...] }
adde project rm myproj --force                  # delete config root only — vault (conversation data) preserved
```

`project rm` deletes only the **config root** (`~/.config/adde/projects/<proj>/`) — settings, session records, and runtime state. **Vault data (events, notes, blobs, dedup ledger) is never touched** — the project's history stays recoverable by re-running `project add` against the same vault path.

## session — manage sessions

```bash
adde session new <proj> [--engine <id>] [--title <t>] [--engine-args <args>] [--json]
adde session ls <proj> [--json]
adde session show <proj> <sid> [--json]
adde session clear <proj> <sid>     # succession — new session created, old one archived (not deleted)
adde session rm <proj> <sid> [--purge] [--force]
```

`session clear` **never deletes** — it creates a fresh session, moves the old one's bindings to the new session, and marks the old one `archived`. Actual deletion only happens via `session rm`; without `--purge` only the session record is removed (vault notes are untouched, since they are the durable original); `--purge` is destructive and requires confirmation (or `--force`).

```bash
adde session new myproj --title "frontend work"
adde session ls myproj --json
adde session clear myproj a1b2c3d4        # succession, not deletion
```

## bind — manage channel bindings

```bash
adde bind add <proj> <sid> --surface <id> --address <addr>
adde bind rm <proj> <sid> --surface <id> --address <addr>
adde bind ls <proj> [--json]
```

`--surface` is one of the registered surfaces (`markdown` implemented; `telegram`/`discord` listed but **stub — binding creation is refused**). For `markdown`, `--address` is the session's input-note path inside the vault; a session's bindings are created automatically as part of `project`/`session` creation for the default markdown surface, so `bind` is mainly for inspecting (`bind ls`) or adding an **additional** binding.

## vault — vault maintenance

```bash
adde vault rebuild <proj> [--sid <sid>] [--json]
```

Regenerates the project's (or one session's, with `--sid`) markdown notes and dedup ledger **purely from the conversation event record** — the record is the only original; notes/blobs-references/dedup results are all derivable and safe to delete. Idempotent — running it repeatedly against the same record produces the same result. Use it to recover from an accidentally deleted/corrupted note tree, or after moving/relocating notes.

```bash
adde vault rebuild myproj              # regenerate every session's notes
adde vault rebuild myproj --sid a1b2c3d4 --json
```

## Session control (markdown palette)

Resetting, compacting, and resuming a session is instructed **from the channel**, not the CLI — a resident checkbox palette at the top of each session's input note (`markdown.palette`, default on):

| Marker             | Action  | Result                                                                              |
| ------------------ | ------- | ----------------------------------------------------------------------------------- |
| `- [ ] 🗄️ archive` | Tidy    | Collapse completed send markers in the records zone into a summary line             |
| `- [ ] 🧹 clear`   | Reset   | Start a new session (succession — see [`session clear`](#session--manage-sessions)) |
| `- [ ] 🗜️ compact` | Compact | Run the engine's own compact command (only rendered if `caps.compact !== "none"`)   |
| `- [ ] ♻️ resume`  | Resume  | Retry resuming a `detached`/`hibernated` session                                    |

Checking a marker runs it once and it is restored to unchecked in place — it's a resident control, not a one-shot message. See the [markdown guide](markdown.md#3-sending-instructions-inbox) for the full 3-zone layout. Telegram/Discord are not implemented (stub) in this release, so there is no chat-command equivalent yet.

## completion — shell completion

```bash
adde completion <bash|zsh>
```

Prints a command/flag completion script to stdout (does not install anything). Completes top-level commands, `project`/`session`/`bind`/`vault` subcommands and their flags, enum flag values (`--perm-tier`, `--file-mode`, `--lang`, `--sync-provider`, `--surface`), directory paths (`--cwd`/`--vault`/`--backup`), and — scanned live from the config root — project and session names. Editable `project set` keys complete at the command's key position; project/session name completion covers command·subcommand·project-name only (setting-key and flag-enum-value completion for `project set` is more limited than in v0.1.x).

```bash
adde completion zsh > "${fpath[1]}/_adde"
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

## Help and typo hints

- `adde <command> --help` prints that command's usage and exits 0.
- An unsupported command prints `Unknown command` + a nearest-command guess to stderr and exits 1.
- An unsupported flag or a missing required argument prints an error + usage to stderr and exits **2**.

## Exit codes

- **0**: success (including `--help`/`--version`).
- **2**: the call itself was malformed — unsupported flag, bad/missing flag value, missing required argument.
- **1**: everything else that isn't success — an operational failure, unsupported command/subcommand, a `detached` session or crash-loop halt reported by `status`, a `FAIL` check from `doctor`.

## Language (locale)

- **Decision order**: `ADDE_LANG` (explicit) > `LC_ALL` > `LC_MESSAGES` > `LANG` (`ko*` → Korean) > default English.
- **Per-project channel language**: `adde project set <proj> lang <en|ko>` fixes the language of that project's channel messages (permission prompts, notices). Unset follows the daemon's global locale.

## Paths

- Config root: `~/.config/adde` (override with `ADDE_HOME`).
- Project settings: `<config-root>/projects/<proj>/{project.conf, sessions.d/<sid>.json, .env, runtime/{runtime.json, engines.json, retention-last-run, control/, sessions/<sid>/{queue, processing, engine.log}}}`.
- Vault (user-specified at `project add --vault`): `<vault>/adde/projects/<proj>/{project.md, sessions/<sid>/{session.md, inbox.md, approvals/<permId>.md, turns/<NNNN ts>.md}, .adde/{sessions/<sid>/{events-NNNN.jsonl, gen-NNNN.summary.json}, blobs/<aa>/<sha256>, ledger/dedup.jsonl}}`.
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist` (macOS only).

Settings/secrets/runtime state live under the config root; conversation data (events, notes, attachments, dedup ledger) lives only in the vault you chose.

## macOS-only features

`adde up`/`down`/`restart` depend on macOS launchd; on other OSes these commands return an error (out of scope for now).

**Reboot auto-recovery**: a daemon registered with `adde up` is always restarted after a macOS reboot/logout (`RunAtLoad`), and every session that was `active` auto-resumes. Crash auto-restart (`KeepAlive`) is separate and throttled — see [`project.conf` auto_restart](#project--manage-projects) and [crash safety](troubleshooting.md#crash-safety--log-rotation).

## Migration from v0.2.x

- `lane add/set/ls/show/rm` → `project add/set/show/ls/rm` (project-level settings) + `session new/ls/show/clear/rm` (per-conversation) + `bind add/rm/ls` (channel↔session link).
- `sessions <proj> <lane>` → `session ls <proj>`.
- `proj ls/rm` → `project ls/rm`.
- v0.2.x settings/data at `~/.config/adde/<proj>/` are **not read or modified** by v2 — `adde doctor` reports their presence for awareness only. v2 uses a physically separate config root (`~/.config/adde/projects/<proj>/`).
