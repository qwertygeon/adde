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
- [factory-reset — wipe everything](#factory-reset--wipe-everything)
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
- **Session**: a unit of conversation with its own id, engine, and lifecycle state (`active` / `hibernated` / `stopped` / `detached`).
- **Binding**: the link between a channel address (e.g. a markdown input note path) and a session.
- **Vault**: the markdown storage root where conversations accumulate as notes (required at project creation).

New sessions get a human-pickable id of the form `YYMMDD-N` — the creation date in local time plus that day's sequence number, e.g. `260828-2`. With a title, the id becomes `YYMMDD-N-<slug>` (e.g. `260828-3-refactor-queue`); a title with no characters in the safe set (`A-Za-z0-9_-`) yields no slug. Ids already assigned are **never renamed**, so the older `<base36>-<8 hex>` form keeps working alongside the new one. **Do not sort session ids lexicographically** — `260828-10` sorts before `260828-2` as text; every listing (`session ls`, the resume list) orders by last activity instead.

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
- **Liveness refresh interval**: while resident, the daemon refreshes its liveness record every `ADDE_HEARTBEAT_INTERVAL_MS` (milliseconds, default `60000`; only a **positive** integer is honored — non-numeric, zero, or negative values fall back to the default). A record that hasn't refreshed for 3x that interval (default 180s) is reported as `stale` by `status` (see below).
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

| Status       | Watched? | Meaning                                                                                                                                                                           |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`     | yes      | Engine process resident, session ready to receive turns                                                                                                                           |
| `hibernated` | yes      | Session alive, engine process not resident (idle timeout or resident-count cap) — resumes transparently on the next turn                                                          |
| `stopped`    | **no**   | You (or auto-stop) ended the watch. The input note and approval directory are not read on any cycle; only an explicit `session resume` (or the palette's `resume`) brings it back |
| `detached`   | **no**   | Resume failed, or the engine gave up self-recovery after repeated crashes — reason recorded and shown in the resume list                                                          |

`stopped` replaces the earlier `archived` state: succession (`session clear`) and an explicit stop both land on `stopped`, and a session record still holding the old `archived` value is **read as `stopped`** without rewriting the file (no migration command, nothing to run).

- **With `<proj>`**: table `SID · STATUS · ENGINE · PRESENT · WARN · TITLE · LAST_ACTIVITY` — every session of that project, whatever its state.
- **Without `<proj>`**: aggregates every registered project, table `PROJECT · SID · STATUS · ENGINE · PRESENT · WARN · LAST_ACTIVITY`.
- **`WARN`**: number of warnings recorded on the session (`-` when none) — storage failures, resume failures, a failed stopped-note rewrite, and the like. The text itself is not shown here; read it with `session show <proj> <session>`.
- **`--all`**: in the aggregated view, include `stopped` and `detached` sessions as well (only `active`/`hibernated` are listed by default).
- **Daemon status line**: below the table, one line per project (`daemon <proj>: <state>`) reports the daemon's actual liveness — `running`, `not responding` (process alive but periodic refresh stopped), `terminated abnormally` (process gone but the liveness record wasn't cleaned up), `not started` (never started, or shut down cleanly — distinct from a session's own `stopped` status), or `undeterminable` (the liveness record exists but can't be parsed, so the state can't be determined). A session's `PRESENT` column reflects this same signal (only shown as present while the daemon is `running` and that session is active) instead of a fixed value. `not responding`/`terminated abnormally`/`undeterminable` and a recorded crash-loop self-halt are shown with remedy guidance (which command to run next).
- **`--json`**: `{ "v": 1, "sessions": [...], "halt": ..., "daemon": ..., "haltUnreadable": ... }` — additive fields, schema version unchanged. `sessions` reflects the full underlying set (not the `--all` display filter). `halt` keeps its original shape (`HaltRecord | null` for a single `<proj>` view, or a per-project map for the aggregated view — see [crash safety & log rotation](troubleshooting.md#crash-safety--log-rotation)); `haltUnreadable` additively reports when a self-halt record exists but can't be read (`string | null` for a single view, a per-project map of only the affected projects for the aggregated view). `daemon` reports the same five-state liveness described above, per project.
- A warning with remedy guidance is printed to stderr and `status` exits non-zero when any of the following holds, evaluated over **every registered project regardless of `<proj>`/`--all` filtering**: a session is `detached`, a crash-loop self-halt is recorded, the daemon is `not responding` or `terminated abnormally`, or a liveness/self-halt record exists but is unreadable (its state can't be determined). A daemon that's simply `not started` is not, by itself, a failure.
- Read-only.

```bash
adde status myproj            # per-session table for one project
adde status --all             # every project, including stopped/detached sessions
adde status myproj --json     # machine-readable {v, sessions, halt, daemon, haltUnreadable}
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
- **Text mode** ends with a summary line totaling the checks by grade (`PASS`/`WARN`/`FAIL`/`INFO`).
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

**Path settings must be absolute.** `vault`, `vault.backup`, and `cwd` are read as absolute paths; a leading `~/` is expanded to your home directory. A relative value is rejected when the settings file is read, which makes every command for that project — and its daemon startup — fail with a settings error until you fix the value (a path that resolves differently depending on where a command was launched from could send a destructive operation somewhere you did not mean). Your shell normally expands `~` before ADDE sees it; a literal `~` only survives if you quoted it (`--vault '~/Vault'`) or edited the settings file by hand. `project add` does not check these values at creation time, so a project created with a relative path is unreadable from the moment it exists — fix the value in the settings file to an absolute path (see [Troubleshooting](troubleshooting.md)).

### `project add` options

| Option                            | Default                                | Description                                                                                         |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--vault <path>`                  | (required)                             | Markdown vault root                                                                                 |
| `--cwd <path>`                    | (none)                                 | Engine working directory                                                                            |
| `--engine <id>`                   | `acp`                                  | Registered engine driver id (see `adde doctor` for the list)                                        |
| `--perm-tier <acp\|autopass>`     | `acp`                                  | Permission tier — see [permissions guide](permissions.md)                                           |
| `--allowlist <a,b,c>`             | (none)                                 | Auto-allowed tools under `acp`                                                                      |
| `--denylist <entries,...>`        | built-in default list, `autopass` only | Tools/patterns that fall back to channel approval under `autopass`                                  |
| `--hard-deny <entries,...>`       | (none)                                 | Tools/patterns refused outright, any tier                                                           |
| `--safe-defaults`                 | —                                      | Seed hard-deny with the built-in danger list (union with explicit `--hard-deny`)                    |
| `--backup <path>`                 | (none)                                 | Retention (archive) destination — see [markdown guide](markdown.md#vault-lightness-retention--sync) |
| `--retention-days <n>`            | `2`                                    | Turn-note age (days) before retention moves it                                                      |
| `--sync-provider <local\|icloud>` | `local`                                | Vault sync provider — `icloud` waits for a not-yet-downloaded file before retention moves it        |

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

`cwd`, `engine`, `engine_args`, `perm_tier`, `allowlist`, `denylist`, `hard_deny`, `gate_timeout_sec`, `lang`, `file_mode`, `auto_restart`, `auto_resume`, `idle_hibernate`, `hibernate_after_min`, `idle_stop`, `stop_after_min`, `max_active_engines`, `auto_relaunch`, `markdown.palette`, `markdown.records_cap`, `markdown.notices_cap`, `vault.backup`, `vault.retention_days`, `vault.sync_provider`.

Three of those keys are new in this release:

| Key                    | Default | Meaning                                                                                                                           |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `idle_stop`            | `true`  | Auto-stop long-inactive sessions. **On by default** — set it to `false` to opt out and sessions will only ever be stopped by hand |
| `stop_after_min`       | `60`    | Minutes since a session's last activity before auto-stop applies                                                                  |
| `markdown.notices_cap` | `10`    | How many notices the input note keeps before the oldest are pruned. **`0` means unlimited**                                       |

```bash
adde project set myproj idle_stop false            # opt out of auto-stop entirely
adde project set myproj stop_after_min 180          # auto-stop after 3 hours of inactivity
adde project set myproj markdown.notices_cap 0      # keep every notice (no cap)
```

`stop_after_min` and `hibernate_after_min` are both measured from the session's **last activity**, not from the moment it hibernated. If `stop_after_min` is less than or equal to `hibernate_after_min`, a session goes straight from `active` to `stopped` without passing through `hibernated`. Exceeding the resident-engine cap (`max_active_engines`) still only hibernates — it never stops a session.

`vault` itself is not editable (identity field, set once at `project add`). A batch of edits is **all-or-nothing** — an unknown key or an invalid value rejects the whole command and writes nothing. If a settings file is hand-edited to an unusable value (a negative `markdown.notices_cap`, a non-integer `stop_after_min`), that key falls back to its built-in default instead of the bad value being silently accepted.

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
adde session clear <proj> <sid>              # succession — stop this session and create a new one
adde session stop <proj> <sid> [--json]      # end the watch on a session
adde session resume <proj> [<sid>] [--json]  # bring a stopped/detached session back
adde session rm <proj> <sid> [--purge]       # remove (interactive three-way)
```

`session ls` is a **record view** — it reads the session records under the config root and works whether or not the daemon is running (for live engine presence use `adde status`). Rows are ordered by last activity, newest first, and each row carries the id, state, engine, title (`-` when untitled) and last-activity timestamp.

`session clear` **never deletes** — it stops the current session, creates a fresh one, moves the bindings over, and cross-links the two: the new session's note gets a link back to the predecessor and the stopped session's note gets a link forward to its successor. Both notes stay in the vault.

```bash
adde session new myproj --title "frontend work"
adde session ls myproj --json
adde session clear myproj 260828-2        # succession, not deletion
```

### `session stop` / `session resume`

```bash
adde session stop myproj 260828-2       # stop watching this session
adde session resume myproj 260828-2     # start watching it again
adde session resume myproj              # how many sessions are eligible to resume
```

`stop` ends the watch: the session's engine goes down and its input note and approval directory are no longer read on any cycle. If the session still has work in flight — a turn running, envelopes left in the queue, or an unconsumed send checkbox — the stop is **scheduled** instead of applied immediately; a notice says so, and the session is stopped for real once the remaining work drains (a second notice confirms it). A scheduled stop survives a daemon restart; if it can't be carried over, that fact is surfaced as a notice rather than silently dropped.

`resume` moves a `stopped` or `detached` session back to `active` and restores its input note to the normal layout, keeping any draft you had left in it. Called without `<sid>`, it only reports how many sessions are eligible and points you at `session ls` — it does not open a picker (the picker lives in the input note, see [session control](#session-control-markdown-palette)).

- Both commands are honest about state mismatches: stopping an already-stopped session, or resuming one that is neither `stopped` nor `detached`, prints the mismatch and exits non-zero instead of reporting a no-op as success. Resuming with nothing eligible, an unknown id, or a malformed id each print their own message.
- Both work **while the project's daemon is running** — the request goes through a control queue the daemon drains, so the change actually takes effect instead of being overwritten by the resident process. If the outcome cannot be observed (a daemon took the request but never answered), the command refuses and tells you to `adde restart <proj>` and retry.

**Automatic stop.** Sessions you leave alone are stopped for you: once a session has been inactive for `stop_after_min` (default 60) minutes, `idle_stop` (default **on**) moves it to `stopped` and records "inactive" as the reason, which is shown in the stopped session's note. Set `idle_stop false` on the project to opt out — see [`project set`](#project-set--edit-settings). Hibernation (`idle_hibernate` / `hibernate_after_min`, default 30 minutes) is unchanged and still comes first; a session that exceeds the resident-engine cap is only hibernated, never stopped.

### `session rm` — three-way removal

`session rm` was redesigned in this release. The old `--force` flag is **gone** — passing it is rejected as an unrecognized flag (exit 2) — and an interactive prompt takes its place.

On a terminal with no options, `session rm` first prints what would be deleted (the paths, the turn count, whether a turn is in flight) and then offers three choices:

| Choice             | Deletes                                                                                                                                                                                              | Keeps                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Full removal**   | Everything that session owns: its record, queue, in-flight directory and engine log under the config root, **and** its notes, approval notes, event record, blob store and dedup ledger in the vault | Nothing of that session. No other session's files are touched                             |
| **Record removal** | The config-root side only (record, queue, in-flight directory, session runtime directory)                                                                                                            | The whole vault side — notes, event record, blobs, dedup ledger                           |
| **Cancel**         | Nothing                                                                                                                                                                                              | Everything (exits non-zero, so a cancelled removal is never mistaken for a completed one) |

- **Full removal is irreversible** and the confirmation text says so. It needs no reference counting: since every one of those paths belongs to exactly one session, deleting the session's directories completes the job.
- **Record removal** makes the session disappear from the listings while the conversation stays readable in the vault, so no regeneration command is needed afterwards. The leftover input note is rewritten once into a short "removed" banner with no palette and no send checkbox — a note nobody polls would otherwise keep checkboxes that can never be consumed.
- **A session created before the storage-layout change of this release** is flagged as such in the inventory, and full removal reports the limit honestly: promoted content written under the old project-wide layout is **left where it is**, so full removal cannot reach it. The only way to clear that is [`factory-reset`](#factory-reset--wipe-everything).
- If the target does not exist, that is reported as "not found" with a non-zero exit — never as a successful deletion. If some paths fail to delete, the failures are collected, printed, and the command exits non-zero.

For scripts and non-interactive shells:

```bash
adde session rm myproj 260828-2 --purge    # full removal, no prompt
adde session rm myproj 260828-2            # in a non-interactive shell: refused, nothing deleted
```

`--purge` means full removal and asks nothing, so it is the non-interactive form. Running `session rm` with no option outside a terminal prints usage and exits 2 without touching anything (fail-closed) — the destructive choice is never made for you by default.

### `session attach` / `session detach`

Not implemented in this release. When they land, they will be the **ownership baton for taking turns with a TUI** — handing an already-running session's terminal over to an interactive client and taking it back — which is a different concept from stopping a session. `stop` ends the watch and the session takes no more turns until it is resumed; `attach`/`detach` will not change whether a session is watched at all. Note that the `detached` **state** is unrelated to a future `detach` command: it means a resume failed.

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
adde vault rebuild myproj --sid 260828-2 --json
```

## factory-reset — wipe everything

```bash
adde factory-reset
```

Removes **every project and every session** and returns ADDE to a fresh-install state. It takes no arguments and no flags.

- **Deletes**: for each project listed in the inventory, its settings directory under the config root (`~/.config/adde/projects/<proj>/`) and the ADDE subtree inside its vault (`<vault>/adde/projects/<proj>/` — notes, event records, blobs, dedup ledgers). Deletion is **per project**, not one sweep of the container; the container itself is only removed if it ends up empty.
- **Keeps**: your vault root itself and everything outside ADDE's namespace inside it. Pre-v2 (v0.2.x) data at `~/.config/adde/<proj>/` is not touched, and the result explicitly lists what was preserved.
- **Keeps what it cannot read**: a directory whose name is outside the allowed character set, or whose settings file cannot be parsed, is **left in place on purpose** and listed in the inventory as excluded from deletion — so the range you were shown and the range actually deleted are the same.
- **Command-only**: there is deliberately no note or palette entry for it. A sync-conflict copy or one stray checkbox must not be able to destroy an installation.
- **Interactive only**: in a non-interactive shell it refuses and exits non-zero without deleting anything.
- **Confirmation**: it prints an inventory first (project count, session count per project, vault paths, anything it will preserve) and then requires you to type a fixed phrase exactly. There is no yes/no shortcut and a mismatched phrase deletes nothing.
- **Daemons must be down**: each project's daemon is stopped first and the absence of a residual daemon is verified. If one survives, nothing is deleted at all — a running daemon would recreate the very records being removed and leave you half-reset.
- **Honest failure**: a partial failure is never reported as success; whatever remains is listed and the command exits non-zero.
- **Stray directories**: ADDE project directories still sitting in a known vault that no project config points at are listed and confirmed **separately** (kept by default). Directories in a vault that no config mentions at all cannot be discovered — which is why the inventory is built before anything is deleted, and why the result says so.
- **Projects whose vault cannot be resolved** (path gone, permission denied, link loop, …) are shown in the inventory with their path and the reason, and after the phrase confirmation you get a **separate question** asking whether to delete just their settings (default no). Their vault side is never touched — the deletion range cannot be established — and if you decline, the settings stay so the location of whatever remains in that vault is not lost, which the result states.
- **Real-path recheck immediately before deleting**: if the real location of a target is not inside that vault's ADDE folder — including the case where a path component is a symlink pointing outside the vault, or elsewhere inside it — both the vault deletion **and** that project's settings deletion are held back, the reason is reported with "clean up the link and run again", and the command exits non-zero. Settings are the only record of where a vault is, so deleting them alone would make the remaining data unfindable. The same recheck guards stray deletion.
- **Known limits**: a link swapped in between the check and the delete is not prevented (Node's file API has no way to delete "exactly the object that was checked"). How a sync client reproduces symlinks has not been verified, so avoid links pointing outside the ADDE folder inside a synced vault. Externally sourced strings shown on the confirmation screen (the vault value from settings, directory names) have control characters folded for display; formatting and bidirectional characters are not covered. Sanitizing applies to display only — the deletion range is unaffected.
- This is the only way to clear content promoted under the pre-release storage layout that a per-session full removal cannot reach — see [`session rm`](#session-rm--three-way-removal).

## Session control (markdown palette)

Resetting, compacting, stopping, and resuming a session is instructed **from the channel**, not the CLI — a resident checkbox palette at the top of each session's input note (`markdown.palette`, default on). The palette is grouped by function, with a plain (non-checkbox) heading line per group:

| Group     | Marker             | Result                                                                                                                   |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `records` | `- [ ] 🗄️ archive` | Collapse completed send markers in the records zone into a summary line                                                  |
| `session` | `- [ ] 🗜️ compact` | Run the engine's own compact command (only rendered if the engine declares compact support); a notice confirms it worked |
| `session` | `- [ ] 🧹 clear`   | Stop this session and start a new one (succession — see [`session clear`](#session--manage-sessions))                    |
| `session` | `- [ ] ⏹️ stop`    | Stop **this** session and nothing else — no new session is created                                                       |
| `session` | `- [ ] ♻️ resume`  | Resume a **different**, already-stopped session — see below                                                              |

The group headings are ordinary bold lines, not checkboxes, so they are never parsed as an action and never mistaken for draft text.

**`resume` changed meaning in this release.** It used to mean "retry resuming _this_ session's engine"; that entry no longer exists. A hibernated session resumes transparently on its next instruction, and a detached one is handled from another session's resume list, so nothing is left unreachable — but if you were used to checking `resume` to poke your own session, that is what became of it. `resume` now works in two forms, both from an **active** session's note:

- `- [x] ♻️ resume` — on the next cycle the notice zone renders the stopped and detached sessions as a checkbox list (id, title, last activity, state, and for a detached session its reason). Check one and that session is resumed; the list then disappears. The list shows the **10 most recent** entries and, when it truncates, says so and tells you to run `adde session ls <proj>` for the full set. With nothing eligible you get a short notice instead of an empty list.
- `- [x] ♻️ resume 260828-2` — skip the list and resume that id directly (exact match). An unknown id or a malformed one produces its own notice.

Checking a marker runs it once and it is restored to unchecked in place — it's a resident control, not a one-shot message.

**A stopped session's note has no palette at all.** When a session stops, its input note is rewritten once into a banner saying the note is no longer watched, why it stopped, and the two ways to bring it back (`♻️ resume` in an active session's note, or `adde session resume <proj> <sid>` in a terminal — the CLI path is listed because there may be no active session to check a box in). Every checkbox is removed, the `records` group included: nothing polls that note, so a leftover checkbox would never be consumed. Your draft text and the records zone are preserved, and resuming restores the normal layout with the draft intact. A detached session's note gets the same treatment with its failure reason in the banner.

See the [markdown guide](markdown.md#2-sending-instructions-inbox) for the full note layout, including the notice zone. Telegram/Discord are not implemented (stub) in this release, so there is no chat-command equivalent yet.

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
- **1**: everything else that isn't success — an operational failure, unsupported command/subcommand, a `FAIL` check from `doctor`, or a `status` failure condition: a `detached` session, a recorded crash-loop self-halt, a daemon that's `not responding`/`terminated abnormally`, or a liveness/self-halt record that's unreadable (state can't be determined) — evaluated across every registered project regardless of display filtering; a daemon that's simply `not started` does not by itself fail.

## Language (locale)

- **Decision order**: `ADDE_LANG` (explicit) > `LC_ALL` > `LC_MESSAGES` > `LANG` (`ko*` → Korean) > default English.
- **Per-project channel language**: `adde project set <proj> lang <en|ko>` fixes the language of that project's channel messages (permission prompts, notices). Unset follows the daemon's global locale.

## Paths

- Config root: `~/.config/adde` (override with `ADDE_HOME`).
- Project settings: `<config-root>/projects/<proj>/{project.conf, sessions.d/<sid>.json, .env, runtime/{runtime.json, engines.json, retention-last-run, control/, sessions/<sid>/{queue, processing, engine.log}}}`.
- Vault (user-specified at `project add --vault`): `<vault>/adde/projects/<proj>/{project.md, sessions/<sid>/{session.md, inbox.md, approvals/<permId>.md, turns/<NNNN ts>.md}, .adde/sessions/<sid>/{events-NNNN.jsonl, gen-NNNN.summary.json, blobs/<aa>/<sha256>, dedup.jsonl}}`.
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist` (macOS only).

Settings/secrets/runtime state live under the config root; conversation data (events, notes, attachments, dedup ledger) lives only in the vault you chose.

**Per-session attachment store and dedup ledger (BREAKING).** The content-addressed store for attachments and oversized tool output, and the ledger that records exact-duplicate matches, are now **owned by the session** (`.adde/sessions/<sid>/blobs/` and `.adde/sessions/<sid>/dedup.jsonl`) rather than shared across a project. Two consequences:

- **Duplicate detection is now within a session only.** Sending the same text in two different sessions no longer links the second one back to the first — each session carries the content in full. Within one session, a repeat still links to the earlier turn as before. This is a deliberate reduction in scope: it removes reference counting from the destructive path, so a full removal can never delete content another session still points at.
- **The earlier promise that identical content is stored only once now applies per session**, not per project. The same attachment held by two sessions exists twice on disk (and is uploaded twice by your sync tool).

Data written before this change is **left exactly where it was** (`<vault>/adde/projects/<proj>/.adde/blobs/` and `.adde/ledger/dedup.jsonl`) — it is neither moved nor rewritten, and there is no migration to run. The trade-off is stated under [`session rm`](#session-rm--three-way-removal): for a session from before the change, full removal cannot reach content in the old location, and [`factory-reset`](#factory-reset--wipe-everything) is the only complete guarantee.

## macOS-only features

`adde up`/`down`/`restart` depend on macOS launchd; on other OSes these commands return an error (out of scope for now).

**Reboot auto-recovery**: a daemon registered with `adde up` is always restarted after a macOS reboot/logout (`RunAtLoad`), and every session that was `active` auto-resumes. Crash auto-restart (`KeepAlive`) is separate and throttled — see [`project.conf` auto_restart](#project--manage-projects) and [crash safety](troubleshooting.md#crash-safety--log-rotation).

## Migration from v0.2.x

- `lane add/set/ls/show/rm` → `project add/set/show/ls/rm` (project-level settings) + `session new/ls/show/clear/stop/resume/rm` (per-conversation) + `bind add/rm/ls` (channel↔session link).
- `sessions <proj> <lane>` → `session ls <proj>`.
- `proj ls/rm` → `project ls/rm`.
- v0.2.x settings/data at `~/.config/adde/<proj>/` are **not read or modified** by v2 — `adde doctor` reports their presence for awareness only. v2 uses a physically separate config root (`~/.config/adde/projects/<proj>/`).
