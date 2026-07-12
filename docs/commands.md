_English | [한국어](commands.ko.md)_

# Command reference

The full command and option set of the ADDE CLI. The single main entry point is `adde`. The short aliases (`ad`, `add`) are not installed by default; you can opt into them via `adde init` (the onboarding wizard) or `adde alias`.

## Table of Contents

- [Global options](#global-options)
- [init — onboarding wizard](#init--onboarding-wizard)
- [alias — install short aliases](#alias--install-short-aliases)
- [up — start lanes (daemon)](#up--start-lanes-daemon)
- [down — stop lanes](#down--stop-lanes)
- [restart — restart lanes](#restart--restart-lanes)
- [proj.conf — daemon crash auto-restart](#projconf--daemon-crash-auto-restart)
- [status — lane status](#status--lane-status)
- [doctor — environment check](#doctor--environment-check)
- [logs — recent activity](#logs--recent-activity)
- [sessions — session list](#sessions--session-list)
- [Session control (channel commands)](#session-control-channel-commands)
- [lane — lane configuration](#lane--lane-configuration)
- [proj — project listing and deletion](#proj--project-listing-and-deletion)
- [completion — shell completion](#completion--shell-completion)
- [Help and typo hints](#help-and-typo-hints)
- [Exit codes](#exit-codes)
- [Language (locale)](#language-locale)
- [Paths](#paths)
- [macOS-only features](#macos-only-features)

## Global options

| Option            | Description   |
| ----------------- | ------------- |
| `-v`, `--version` | Print version |
| `-h`, `--help`    | Print help    |

`-v`/`--version` and `-h`/`--help` are recognized regardless of where they appear in the argument list — e.g. `adde up --version` prints the version instead of being treated as a project name (`[behavior-change]`).

Running `adde` with no arguments, or `-h`/`--help`/`help`, prints the overall usage. For a specific command's help, `adde <command> --help` (e.g. `adde status --help`, `adde lane add --help`) — if a known command precedes `--help`, that command's usage is shown; otherwise the overall usage is shown.

## init — onboarding wizard

```bash
adde init [<proj>]
```

An onboarding wizard that creates your first lane interactively (**TTY only** — in a non-interactive environment it prints an error and exits with code 1). It proceeds in this order:

1. Runs the global `doctor` and prints the results (continues even if there are `FAIL`s, with a warning).
2. Offers to install the short aliases (default yes — see `alias` below).
3. Prompts for project and lane names (validated: letters, digits, `_`, `-` only).
4. Collects lane fields interactively (the same fields as an interactive `lane add`). For a telegram lane the bot token is prompted **last, with hidden input** (keystrokes are not echoed) and written to `.env` (0600). Leaving it empty defers it (set it later via `--token-stdin` or by editing `.env`).
5. Creates the lane.
6. Prints the token-written (or token-next) hint and the `adde up` start hint.

**Example session** (telegram lane; hidden token entered — the input is not shown on screen):

```text
$ adde init
adde setup — environment check, short aliases, and your first lane.

  ✔ Node version: v22.14.0
  ✔ ACP adapter binary: @agentclientprotocol/claude-agent-acp resolved
  ✔ config base directory: ~/.config/adde
  ✔ daemon entry: /opt/homebrew/lib/node_modules/adde/dist/cli/adde.js

install short aliases (ad, add) next to the adde command? (Y/n) [y]: y
  ✔ alias created: ad → /usr/local/bin
  ✔ alias created: add → /usr/local/bin

project name [default]: myproj
lane name [main]: tg-claude
source (enter a number or the value)
  1) markdown
  2) telegram [markdown]: 2
perm_tier (acp = approve each tool in the channel / autopass = auto-allow except denylist)
  1) acp
  2) autopass [acp]:
allowlist (comma-separated, empty for none): Read,Grep
enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright (y/N) [y]: y
lang (channel message locale, empty for global)
  1) en
  2) ko:
cwd (absolute lane working directory, empty to skip): /Users/me/work/my-project
engine_args (extra CLI args for the engine process, space-separated, empty to skip — not a place for secrets: engine args become visible in the OS process list):
file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable)
  1) private
  2) shared [private]:
chat_id (reply target + authorizes that chat for inbound, empty to skip): 12345678
allow_from (extra authorized sender ids, comma-separated, empty to skip):
telegram bot token (hidden input, empty to set later): ⟨input hidden⟩

lane "tg-claude" created: ~/.config/adde/myproj/lanes.d/tg-claude.conf
token written: ~/.config/adde/myproj/state/tg-claude/.env (0600)

Setup complete for project 'myproj'.
Start: adde up myproj
```

An empty answer accepts the shown default (`[…]`). If you leave the token empty, the last two lines become a `Next: put the bot token in …/.env as TELEGRAM_BOT_TOKEN=...` hint instead of `token written`. For a `markdown` source the `chat_id`/`allow_from`/token prompts are replaced by `root`/`inbox`/`approvals`/`outbox`.

## alias — install short aliases

```bash
adde alias [names...]
```

Installs short-alias symlinks next to the `adde` executable found in PATH (default `ad`, `add`). Passing names as arguments installs those names instead.

- `[names...]`: one or more alias names to install (default `ad add`). Example: `adde alias co assistant` installs `co` and `assistant`.
- **An existing command is skipped**: if a command with that name already exists in PATH and is not our own symlink, it is **not overwritten and is reported as a failure**.
- **Idempotent**: a symlink already pointing to adde is reported as already set.
- **`adde` not found**: if `adde` is not found in PATH (e.g. not a global install), it prints a notice and exits with code 1.

## up — start lanes (daemon)

```bash
adde up <proj>
```

Starts every `*.conf` lane in `~/.config/adde/<proj>/lanes.d/` as a **macOS launchd LaunchAgent daemon**. `adde up` itself exits immediately after registering the plist, and the actual lanes run as background daemons (managed by `launchd`).

- **Terminal-independent**: the daemon keeps running even after you close the terminal.
- **Crash-only auto-restart**: launchd restarts the daemon on a crash (non-zero exit or a fatal signal), throttled to at most once every 60 seconds, and always relaunches it after a macOS reboot/logout (`RunAtLoad`). A deliberate stop (`adde down`, or a `SIGTERM` that completes its graceful shutdown) exits cleanly and is **not** restarted, and a deterministic boot failure (e.g. zero lanes configured, or a boot-time config error) also exits cleanly instead of looping forever — the failure is still surfaced (see below), it just isn't retried automatically. See [`proj.conf` — daemon crash auto-restart](#projconf--daemon-crash-auto-restart) to opt out, and [crash safety & log rotation](troubleshooting.md#crash-safety--log-rotation) for the crash-loop self-halt safety net.
- **Startup result**: after registering, `adde up` waits for the daemon to record a **boot report** (`<base>/<proj>/daemon-boot-report.json`, written once on `supervisorUp` completion with each lane's final status/reason and a boot id) and consumes only the report matching the boot it just started — a leftover report from a previous boot is never mistaken for this one. It then prints a summary (`N running · M failed`). Any lane that **failed to start** is listed with its reason, and `adde up` exits non-zero — so you learn about failures immediately instead of having to check `adde status` (if the report shows every lane failed, this is surfaced immediately without waiting out the full window). (The failure is also recorded as `error` state; see `adde logs <proj> --daemon` for the daemon-level cause.) If **no matching report** appears within the wait window (the daemon likely failed to boot before recording one), `adde up` reports it and exits non-zero with a pointer to `adde logs <proj> --daemon`. The wait window can be extended on slow machines via the `ADDE_UP_WAIT_MS` (milliseconds) env var — default `8000`; only a **positive** integer is honored (non-numeric, zero, or negative values fall back to the default silently). The older `ADDE_UP_POLL_MS` name is **no longer honored** (no fallback) — if only it is set, a one-time stderr hint points you to `ADDE_UP_WAIT_MS`. `adde restart` waits for its own re-launch's report the same way and honors the same env var.
- **Already-up notice**: if the daemon is already registered _and_ has at least one running lane, `adde up` does not re-register (which would fail as "already loaded"). Instead it prints an "already up" line with the running/total lane count and hints (`adde status` to view, `adde restart` to apply conf changes, `adde down` to stop). If any lane is currently unhealthy (`error`/`dead`/`stale`), it is listed and `adde up` exits non-zero here too. If the registration is present but **no lane is actually running** (e.g. after a deterministic boot failure that exited cleanly), `adde up` does not just report "already up" — it re-registers the daemon (unload+load) to recover it, then polls as a fresh start.
- **Double-start guard**: within the daemon, an already-running lane is skipped with a warning (recorded in the daemon log). Double starts do not happen.
- **macOS only**: the launchd feature works only on macOS. See [macOS-only features](#macos-only-features) for details.

At startup a plist file (`~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist`) is created and registered with launchd. Each lane's status is recorded in `state/<lane>/runtime.json`.

## down — stop lanes

```bash
adde down <proj>
```

Stops that project's launchd daemon and removes the plist file. It can run **from any terminal** (cross-process termination).

## restart — restart lanes

```bash
adde restart <proj>
```

Performs `down` then `up`, in order. Use it to restart the daemon after a config change, or to reset the daemon state.

- If `up` fails after `down` succeeds, it surfaces the `up` error and returns exit code 1.
- **[behavior-change] Startup result surfacing**: after re-registering, `restart` waits for the same boot report `up` waits for and prints a summary (`N running · M failed`). Any lane that **failed to start** is listed with its reason, and `restart` now returns **exit code 1** if one or more lanes failed (previously it always returned 0 as long as the launchctl re-registration itself didn't throw — a lane startup failure could look like success). All lanes starting successfully still returns exit 0. `restart` also clears the crash-loop self-halt marker _before_ the boot it waits on, so an explicit retry is not blocked by a stale halt. The wait window is the same `ADDE_UP_WAIT_MS` env var used by `up` (see [`up`](#up--start-lanes-daemon)).
- The plist is re-rendered from scratch on every `restart` (and every `up`), so it always picks up the current [`proj.conf`](#projconf--daemon-crash-auto-restart) `auto_restart` value — there is no separate migration step after editing it.
- `restart` also clears the crash-loop self-halt marker (see [crash safety & log rotation](troubleshooting.md#crash-safety--log-rotation)), since running it is an explicit retry.

## proj.conf — daemon crash auto-restart

`<base>/<proj>/proj.conf` is a project-level (not per-lane) plain `key=value` settings file, edited by hand — there is no `adde` subcommand or flag for it.

```
# ~/.config/adde/<proj>/proj.conf
auto_restart=false
```

- **Key**: `auto_restart` (boolean). Defaults to **on** — a missing file, a missing key, or an invalid value are all treated as on; only the literal `false` turns it off.
- **Effect**: controls whether launchd auto-restarts the daemon after a crash (see the crash-only auto-restart note under [`up`](#up--start-lanes-daemon)). It does not affect `RunAtLoad` — reboot/logout auto-recovery keeps working either way — and it has no effect on a deliberate stop (`adde down` always stops the daemon regardless of this setting).
- **When to use `auto_restart=false`**: a project whose daemon keeps crashing and you don't want launchd retrying in the background while you investigate (e.g. so you can watch a single failed run cleanly), or where you'd rather rely on the crash-loop self-halt for observability without the intervening restarts. With it off, a crash leaves the daemon down until you run `adde up`/`adde restart`; `adde status`/`adde doctor` surface that "registered but not running" state so it isn't silently mistaken for `running`.
- Applying a change requires `adde restart <proj>` (plist is re-rendered from `proj.conf` on every `up`/`restart`).

## status — lane status

```bash
adde status [<proj>] [--all] [--json]
```

Scans each lane in `lanes.d` and determines its status.

| Status    | Meaning                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` | State file exists, the launched process (pid) is alive, and the heartbeat is fresh                                                                                                                                          |
| `stale`   | The pid is alive but the heartbeat (state-file mtime) has stopped — **suspected hung, or an engine crash currently being auto-recovered** (see [troubleshooting](troubleshooting.md#engine-crash--self-recovery))           |
| `dead`    | State file exists but the process is gone — **abnormal exit (crash) residue**                                                                                                                                               |
| `error`   | The lane **failed to start** (engine spawn/handshake, missing config, …), or an engine that crashed after starting **gave up self-recovery** (or has it disabled, `auto_relaunch=false`) — the reason is recorded and shown |
| `stopped` | No state file — normal exit or never started                                                                                                                                                                                |

- **With `<proj>`**: prints all lanes of that project (including stopped) in a `LANE · STATUS · PID · UPTIME · SEEN · SOURCE` table.
- **Without `<proj>`**: aggregates all projects (`~/.config/adde/*/`) and prints **running (non-stopped) lanes** in a `PROJECT · LANE · …` table. If no lanes are running, an informational message.
- **`--all`** (when `<proj>` is omitted): show all lanes including stopped (`stopped`).
- If there are `dead`/`stale`/`error` lanes, remedy guidance is appended (`SEEN` = time since the last heartbeat; for `error`, the start-failure reason and a pointer to `adde logs <proj> --daemon`/`--engine`).
- Heartbeat: `adde up` periodically refreshes the state-file mtime. Even if the pid is alive, if the refresh stops past a threshold it is judged `stale` (hung).
- **Crash-loop self-halt (`halt`)**: if the daemon self-halted after repeated short-lived crashes (see [crash safety & log rotation](troubleshooting.md#crash-safety--log-rotation)), `status` prints a warning for the affected project **and now also returns exit code 1** for it (previously `halt` only produced the warning text and did not affect the exit code — the same `dead`/`stale`/`error` → exit 1 rule already applied and still applies). The aggregate (no-`<proj>`) view detects `halt` against the full set of projects, not just the lanes shown in the table — a project whose lanes are all `stopped` (and therefore filtered out of the default aggregate table) still surfaces its `halt` warning and exit code 1.
- **[BREAKING] `--json`**: the top-level JSON output is an **object** `{ "lanes": [...], "halt": ... }`, not a bare array (previously `adde status --json` printed a top-level array of lane objects). `lanes` holds the same per-lane objects as before (including `lastSeenAt`; annotated with `proj` when aggregating). `halt` carries the crash-loop self-halt state: `HaltRecord | null` for a single `<proj>` view, or `{ "<proj>": HaltRecord | null, ... }` for the aggregated (no-`<proj>`) view. **Migration**: change a top-level array reference to `.lanes` — e.g. `adde status --json | jq '.[]'` → `jq '.lanes[]'`. The non-JSON (text) output is unchanged.
- **Update notice**: if a newer version is available on npm, a one-line notice is appended (`npm i -g adde-acp@latest` … then `adde restart`). It uses a 24-hour cache (under the config base), only hits the network in an interactive terminal (TTY), and can be disabled with the `ADDE_NO_UPDATE_CHECK` env var.
- Read-only (no side effects).

```bash
adde status myproj          # per-lane table for one project (includes stopped)
adde status --all           # every project, including stopped lanes
adde status myproj --json   # machine-readable {lanes, halt} object (monitoring/scripts)
```

## doctor — environment check

```bash
adde doctor [<proj>] [--json]
```

Performs a static check independent of status and reports each item as `PASS` / `WARN` / `FAIL`. Failures/warnings carry a remedy hint (`↳ action:`).

- Global: Node version (≥22) · ACP adapter binary resolution · config base directory · (macOS) daemon entry file resolution.
- With `<proj>`, per lane: source validity · `cwd` existence · (telegram) `.env` token presence.
- **File-permission audit** (with `<proj>`, per lane): `WARN` if `state/<lane>/.env` is group/other-accessible (expects 0600 — bot-token exposure risk), and `WARN` if `file_mode=private` but the `state/<lane>` directory is group/other-accessible (expects 0700), with a `chmod`/`adde restart` hint. `file_mode=shared` is treated as an intentional choice and not warned.
- With `<proj>`, on macOS it also checks the launchd daemon registration state — it cross-checks plist existence against launchctl registration and surfaces a mismatch (plist present but not registered with launchd, or vice versa) as `WARN`.
- **`--json`**: prints the check list as a JSON array (each item's `name`/`level`/`detail`, plus `hint` when `WARN`/`FAIL`) instead of the human-readable symbol list, and suppresses the summary line and the update notice (machine-readable output only). The exit code meaning is unchanged (`FAIL` present → 1, otherwise 0 — same as the text mode). Without `--json`, output and exit code are exactly as before (additive change).
- **Update notice**: like `status`, if a newer version is available on npm it prints a one-line notice (24-hour cache · network only in TTY · disable with `ADDE_NO_UPDATE_CHECK`) — suppressed in `--json` mode (see above).
- Read-only. It's for self-diagnosing "why won't it start" before startup.

```bash
adde doctor myproj --json   # machine-readable check list (CI/monitoring)
```

## logs — recent activity

```bash
adde logs <proj> <lane> [N] [--engine] [--follow|-f]
adde logs <proj> --daemon [N]
```

Prints the last `N` lines of that lane's `transcript.log` (ACP session event record) (default 50). If the file doesn't exist, prints an informational message.

- `N`: how many trailing lines to print (default 50). If it's given but isn't a positive integer (non-numeric, `0`, or negative), `logs` prints a warning to stderr and falls back to the default 50 (previously it fell back silently with no warning) — this validation applies the same way with `--daemon`.
- `--engine`: prints `engine.log` (the engine subprocess's captured stderr) instead of the transcript. Use it to see the engine's own diagnostic output (tracing `stale`/startup-failure causes, etc.).
- `--daemon`: prints the **launchd daemon log** for the project (`~/Library/Logs/adde/<proj>.err.log`) — `<lane>` is not needed. This is where the background daemon's own output (including **startup-failure causes**) lands, which the per-lane transcript/engine logs don't capture.
- **`--follow`/`-f`**: after printing the initial snapshot, stays running and prints new lines as they're appended (like `tail -f`) — transcript by default, or the engine log with `--engine`, resuming exactly where the snapshot left off (no gap, no duplicate lines). It's driven by an OS file-change notification (`fs.watch` on the containing directory) as the primary trigger, with a low-frequency (1s) stat poll running alongside as a safety net in case notifications are unsupported or an event is missed — so tailing doesn't silently stall. It follows transparently across log rotation (the 5MB size-based rotation) and across a same-inode truncate immediately followed by regrowth (e.g. `copytruncate`-style rotation), with no lost, duplicated, or misaligned lines; multi-byte characters (e.g. Korean) split across a read boundary are decoded intact (no mangled output). Press `Ctrl-C` (`SIGINT`) to stop immediately (no hang, no busy-polling). If the target log doesn't exist yet when you start, it prints the usual "not found" message and exits rather than waiting around for it to be created. `--daemon` logs are **not** followable — `-f` is ignored for `--daemon` and it just prints the snapshot.

```bash
adde logs myproj tg-claude 100 --engine   # last 100 lines of the engine stderr log
adde logs myproj --daemon                 # daemon log (why lanes failed to start)
adde logs myproj tg-claude -f             # live-tail the transcript
adde logs myproj tg-claude --engine -f    # live-tail the engine log
```

## sessions — session list

```bash
adde sessions <proj> <lane> [--json]
```

Prints the lane's engine session ledger — number, first-prompt excerpt, **last conversation time**, and session id (the current session marked with `◀`). Resuming/resetting sessions is done from the channel (see "Session control (channel commands)" below).

- Positional arguments (`<proj>`/`<lane>`) and `--json` can appear in any order — `--json` is never mistaken for a `<proj>`/`<lane>` value.
- **`--json`**: prints the ledger as a JSON array, each entry with `id`/`label`/`createdAt`/`lastActivityAt`/`current` (`true` for the active session). An empty ledger prints a valid empty array `[]` (exit 0). Without `--json`, output and exit code are unchanged.

```bash
adde sessions myproj tg-claude --json   # machine-readable ledger (monitoring/scripts)
```

## Session control (channel commands)

Resetting, compacting, and resuming a conversation session is instructed **from the channel**, not the CLI (it respects the in-progress turn, is processed serially in the message queue, and the result is announced as a channel response).

| Action                      | Markdown (dedicated checkbox label) | Telegram (exact match)         | Result                                                                          |
| --------------------------- | ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Start a new session (reset) | `- [x] 🧹 clear`                    | `/clear`                       | Restart the engine as a new session — clears prior conversation context         |
| Compact context             | `- [x] compact`                     | `/compact`                     | Run the engine's compact command (conversation kept, context condensed)         |
| Session list                | `- [x] resume`                      | `/resume`                      | Respond with a recent-session list (number, excerpt, last conversation time)    |
| Resume a session            | `- [x] resume <number\|session-id>` | `/resume <number\|session-id>` | Return to that session (falls back to a new session with a notice if not found) |

- Markdown labels use the same contract as send: exact label match (leading emoji allowed), runs on check, and after processing the line terminates as `✅ sent [[...]]` with the result note linked.
- Telegram interprets it as control only when the whole message **exactly matches** a command — a `/clear` inside a sentence is passed through as an ordinary prompt. In group chats the bot-mention suffix (`/clear@botname`, `/compact@botname`, `/resume@botname <number>`) is allowed.
- A lane restart (`adde restart`) also starts a new session (no auto-resume — to continue, restart then pick with `/resume`).

## lane — lane configuration

Creates, lists, and deletes a lane conf (`lanes.d/<lane>.conf`). One file = one lane.

```bash
adde lane add <proj> <lane> [options]   # create
adde lane ls <proj>                      # list
adde lane show <proj> <lane>             # print conf
adde lane rm <proj> <lane> [--purge]     # delete conf (--purge also removes state/queue/out)
adde lane help                           # all options
```

By default `lane rm` deletes only the conf and preserves side data (state/queue/out). `--purge` also removes the lane's `state`/`queue`/`processing`/`out` directories (orphan cleanup). Because `--purge` destroys state (including the bot-token `.env`), it is guarded like `proj rm`: it **refuses if the lane is active** (stop the daemon first, or `--force`), and on a TTY it asks you to re-type the lane name to confirm (non-interactive requires `--force`). Plain `lane rm` (no `--purge`) has no such guard.

`ls`/`rm` can also be written as `list`/`remove` (same behavior).

### lane add options

| Option                                               | Default                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <markdown\|telegram>`                      | `markdown`                                                      | Channel source                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--perm-tier <acp\|autopass>`                        | `acp`                                                           | Permission tier. `acp`=channel-approve every tool / `autopass`=auto-allow outside the denylist (opt-in)                                                                                                                                                                                                                                                                                                                                                               |
| `--cwd <abs-path>`                                   | (supervisor cwd)                                                | This lane's AI working folder (project mapping)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--engine-args <args>`                               | (none)                                                          | Extra CLI args passed to the engine process at spawn, space-separated (e.g. `--model opus`) — quoted/multi-word values aren't supported (a quote in the value makes lane startup fail). These become part of the engine child process's argv, so **it isn't a place for secrets/tokens**: argv is visible to anything that can read the OS process list (e.g. `ps`), and ADDE's own secret-masking only covers its logs/runtime/transcript, not the OS process table. |
| `--allowlist <a,b,c>`                                | (none)                                                          | Auto-allowed tools (gate stays on; for `perm_tier=acp`)                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--denylist <entries,...>`                           | built-in default list under autopass (see **default denylist**) | Tools/patterns to fall back to channel approval under `autopass` — `Bash` (whole tool) or `"Bash(git push*)"` (representative-argument glob)                                                                                                                                                                                                                                                                                                                          |
| `--hard-deny <entries,...>`                          | (none)                                                          | Tools/patterns to **refuse outright** regardless of tier (no channel prompt at all, conf key `hard_deny=`) — same format as `--denylist`                                                                                                                                                                                                                                                                                                                              |
| `--safe-defaults`                                    | —                                                               | Fill hard-deny with the built-in danger list (union with any explicit `--hard-deny`). The interactive `lane add`/`init` asks whether to enable it (default yes)                                                                                                                                                                                                                                                                                                       |
| `--lang <en\|ko>`                                    | (global locale)                                                 | Language of this lane's **channel messages** (permission prompts, warning banner, notice notes)                                                                                                                                                                                                                                                                                                                                                                       |
| `--chat-id <id>`                                     | (none)                                                          | telegram reply target. A **private chat** (positive) auto-allows inbound (group = negative is reply-only; members via `allow_from`)                                                                                                                                                                                                                                                                                                                                   |
| `--allow-from <ids>`                                 | (none)                                                          | telegram inbound-allowed sender user ids (comma-separated). Combined with the private `chat_id` for authentication (required to authenticate group members)                                                                                                                                                                                                                                                                                                           |
| `--file-mode <private\|shared>`                      | `private`                                                       | Permissions of the state/out/queue directories. `private`=0700 (owner only) / `shared`=not locked (umask default, typically readable by other users)                                                                                                                                                                                                                                                                                                                  |
| `--token-stdin`                                      | —                                                               | Read the telegram bot token from stdin and write it to `.env` (0600)                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--root <abs-path>`                                  | (none)                                                          | markdown root (e.g. Obsidian vault)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | —                                                               | markdown note paths (relative to root)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--force`                                            | —                                                               | Overwrite an existing conf                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--interactive`                                      | —                                                               | Force the interactive wizard (TTY only — errors on a non-TTY)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--no-interactive`                                   | —                                                               | Force non-interactive (use flags/defaults, no prompts) — for scripts/CI                                                                                                                                                                                                                                                                                                                                                                                               |

**Interactive by default**: on a TTY, `adde lane add <proj> <lane>` with **no field flags** launches the interactive wizard automatically — no `--interactive` needed. It becomes non-interactive when any field flag is given (`--source`, `--perm-tier`, `--cwd`, `--engine-args`, `--allowlist`, `--denylist`, `--hard-deny`, `--safe-defaults`, `--lang`, `--chat-id`, `--allow-from`, `--file-mode`, `--root`, `--inbox`, `--approvals`, `--outbox`, `--token-stdin`), when `--no-interactive` is passed, or when stdin is not a TTY (scripts/CI). `--interactive` force-enables it (and errors on a non-TTY); `--no-interactive` force-disables it. `<proj>` and `<lane>` are always required positional arguments.

**Engine/backend are fixed, not flags**: ADDE currently drives a single engine (`claude-agent-acp`) over a single backend (`acp`), so `lane add` no longer has `--engine`/`--backend`/`--acp-version` flags (removed — asking about a knob with only one supported value added noise without changing anything). The lane conf's `engine=`/`backend=`/`acp_version=` keys still exist and are validated at lane startup: a typo or unsupported value (only reachable by hand-editing the conf) is rejected before the engine spawns, with the error naming the unsupported value and the supported list, instead of silently doing nothing.

In the wizard, the telegram bot token is prompted **last, with hidden input** (keystrokes not echoed) and written to `.env` (0600); leave it empty to defer it (set it later via `--token-stdin` or by editing `.env`). The wizard also asks whether to enable `--safe-defaults` (the hard-deny danger list, default yes). **Enum fields are shown as a numbered menu** — you can answer with the **number** (`1`, `2`, …) or type the value; `source`, `perm_tier`, `file_mode`, and `lang` work this way. **Path fields (`cwd`, `root`, …) support Tab directory completion.** Numeric fields (`chat_id`, `allow_from`) are validated at entry and re-prompt on bad input. At creation, a missing `cwd`, a missing markdown `root`, or a malformed telegram token is reported as a **warning** but creation still proceeds.

**Example: interactive** (auto-launched on a TTY — the field prompts follow the required `<proj> <lane>`):

```text
$ adde lane add myproj tg-claude
source (enter a number or the value)
  1) markdown
  2) telegram [markdown]: 2
channel [telegram]:
perm_tier (acp = approve each tool in the channel / autopass = auto-allow except denylist)
  1) acp
  2) autopass [acp]: 2
allowlist (comma-separated, empty for none): Read,Grep
denylist (tools/patterns that fall back to channel approval, comma-separated) [Bash(sudo *),…]:
enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright (y/N) [y]: y
lang (channel message locale, empty for global)
  1) en
  2) ko: 2
cwd (absolute lane working directory, empty to skip): /Users/me/work/my-project    # Tab completes paths
engine_args (extra CLI args for the engine process, space-separated, empty to skip — not a place for secrets: engine args become visible in the OS process list):
file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable)
  1) private
  2) shared [private]:
chat_id (reply target + authorizes that chat for inbound, empty to skip): 12345678
allow_from (extra authorized sender ids, comma-separated, empty to skip):
telegram bot token (hidden input, empty to set later): ⟨input hidden⟩

lane "tg-claude" created: ~/.config/adde/myproj/lanes.d/tg-claude.conf
token written: ~/.config/adde/myproj/state/tg-claude/.env (0600)
Start: adde up myproj
```

(The `denylist` prompt appears only when `perm_tier=autopass`. For a `markdown` source, the `chat_id`/`allow_from`/token prompts are replaced by `root`/`inbox` (default `inbox.md`)/`approvals`/`outbox`.)

**Example: scripted** (non-interactive; every value from flags, token piped on stdin — nothing prompted):

```bash
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude \
  --source telegram \
  --cwd /Users/me/work/my-project \
  --perm-tier autopass \
  --denylist "Bash(git push*),Write(/etc/*)" \
  --safe-defaults \
  --hard-deny "Bash(sudo *)" \
  --allowlist Read,Grep \
  --chat-id 12345678 \
  --allow-from 111111,222222 \
  --file-mode private \
  --lang ko \
  --no-interactive \
  --token-stdin
```

Passing `--token-stdin` (or any field flag) already makes the command non-interactive; `--no-interactive` is shown here for explicitness and is what you use in CI where stdin may still be a TTY.

> ⚠️ `--perm-tier autopass` is an opt-in mode that **auto-allows every tool not in the denylist (including file writes and `Bash`) without channel confirmation**. Put tools that need confirmation in `--denylist`. Auto-allow entries are recorded in the transcript, and a warning banner is sent to the channel at startup. The behavior of the default (`acp`) does not change.
>
> allowlist/denylist matching is based on the raw tool name the engine reports (e.g. `Bash`, `Write`); a request whose tool name cannot be determined is not auto-allowed and is sent to channel approval (fail-closed). Tool-name provision is currently confirmed for the `claude-agent-acp` engine — with an engine that does not provide tool names, every request goes through channel approval even under autopass (the safe direction).
>
> **denylist patterns**: `Tool(glob)` format matches the representative argument — Bash is the command string, Read/Write/Edit the file path, WebFetch the URL. `*` is any string (including path separators) and matches against the whole, so a prefix block is `Bash(git push*)` and a contains block is `Bash(*sudo *)`. A request whose argument cannot be determined, or a tool that doesn't support patterns, goes to channel approval even if only the tool name matches (over-matching = the safe direction). Tool-name comparison is case-insensitive. **Shell chaining**: for Bash, each chained/grouped sub-command (split on `;` `&&` `||` `|` `&`, grouping `(` `)` `{` `}`, `$(…)`, backticks, and newline, leading `VAR=` assignments stripped) is matched too, so a prefix pattern (`sudo *`) catches `echo x && sudo y` and `(sudo y)`. Matching is best-effort, not a full shell parser (no alias/`eval`/variable expansion; wrapper invocations like `bash -c "sudo y"` are not caught; operator characters split even inside quotes, so `--safe-defaults` may refuse a benign command whose quoted argument contains an operator plus a danger token) — if a certain block is needed, specify the whole tool (`Bash`).
>
> **default denylist**: under `--perm-tier autopass`, omitting `--denylist` records into the conf a built-in default list that sends destructive shell commands and credential-store reads back to approval — `Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`. The entries are just a list, not complete defense (see shell chaining above) — tune it to your project.
>
> **hard-deny (`--hard-deny` / `--safe-defaults`)**: the same `Tool(glob)` format as `--denylist`, but its strength differs — denylist removes from auto-allow under `autopass` and **falls back to channel approval**, whereas hard-deny **refuses (cancels) a matching request immediately, regardless of `perm_tier` (including the default `acp`), with no channel prompt at all**. It's the last line of defense that prevents catastrophic commands from being accidentally approved. `--safe-defaults` fills hard-deny with the same danger list as the **default denylist** above (union with any explicit `--hard-deny`). Hard-deny hits are recorded in the transcript and announced to the channel. For concepts and recommended use, see the [permissions guide](permissions.md#hard-deny-outright-refusal).

> **Inbound authentication (telegram)**: inbound messages and permission callbacks are processed only from allowed senders and the rest are ignored (fail-closed). Allowed set = **private `chat_id` (positive = that user, self-authenticated) ∪ `allow_from`**. **A group `chat_id` (negative) is only a reply target and does not authenticate members**, so in a group specify the allowed members' user ids with `--allow-from` (a group chat_id alone does not allow the whole group). With no allowed sender, all inbound is denied. This is the boundary that prevents an arbitrary user with access to the bot from injecting a prompt into the host-executing session or approving permissions without authorization.
>
> **File permissions (`--file-mode`)**: the default `private` locks the lane's state/out/queue/lanes.d directories to 0700 (owner only) to block other local users on a multi-user host from reading the conversation, responses, and config metadata. `shared` is an opt-in that does not apply this lock (keeps the existing umask default — typically 0755); use it only when read sharing is needed. (The bot-token `.env` is always 0600 regardless of mode.)
>
> **Engine crash self-recovery (`auto_relaunch`)**: not a `lane add` flag — set directly in the lane's `.conf` file (`auto_relaunch=false`), then `adde restart <proj>`. Defaults to on: if the lane's engine process crashes after the handshake, ADDE relaunches it with a bounded exponential backoff, carrying over the same session, subscribers, and permission handler. `auto_relaunch=false` disables only the automatic relaunch — crash detection, the immediate `error` status, denial of any permission request still pending at crash time, and the one-time channel notice all still happen. See [troubleshooting](troubleshooting.md#engine-crash--self-recovery). (This is a per-lane setting for the _engine_ process; the analogous per-project setting for the _daemon_ process itself is [`proj.conf`'s `auto_restart`](#projconf--daemon-crash-auto-restart).)

## proj — project listing and deletion

Project-level view and teardown (complements the lane-oriented `lane`/`status`).

```bash
adde proj ls                    # list registered projects (with lane + running counts)
adde proj rm <proj> [--force]   # delete a project: all its lanes + state
```

`ls`/`rm` can also be written as `list`/`remove`.

- **`proj ls`** — one row per registered project (a directory under the config base that has a `lanes.d/`) with its lane count and running count. `--json` prints an array for scripts.
- **`proj rm <proj>`** — deletes the entire project directory (`lanes.d` + `state` + `queue` + `processing` + `out`). Because it is destructive:
  - it **refuses** if the project has running/dead/stale lanes — stop the daemon first (`adde down <proj>`), or pass `--force` to delete anyway;
  - on a TTY it asks you to **re-type the project name** to confirm; in a non-interactive shell it requires `--force`;
  - it **unloads the launchd daemon** before deleting, so no orphan plist registration is left behind.

```bash
adde proj ls                    # PROJECT · LANES · RUNNING table
adde down myproj                # stop first if running
adde proj rm myproj             # confirm by re-typing the name
adde proj rm myproj --force     # skip confirmation (scripts/CI)
```

## completion — shell completion

```bash
adde completion <bash|zsh>
```

Prints a command/flag completion script to stdout — **it does not install anything** (you redirect it into your shell's completion directory). It is generated from the command/flag spec, so completion updates automatically as commands grow. The script registers for `adde` plus the short aliases `ad` and `add`. `adde completion --help` explains why/what/where for each shell, and **`adde init` can walk you through installing it** (opt-in, right after the alias step). When run on a terminal (not redirected) it also prints an install hint to stderr.

```bash
# zsh: place on fpath after compinit, or source from .zshrc
adde completion zsh > "${fpath[1]}/_adde"   # or: adde completion zsh >> ~/.zshrc, then re-login

# bash: place in the bash-completion directory, or source from .bashrc
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

**What it completes**:

- **Top-level commands + global flags** — `up`/`down`/…/`lane`/`completion`, and `-h`/`--help`/`-v`/`--version`. In zsh each command shows a short description next to it.
- **Subcommands and fixed values** — `lane add|ls|show|rm|help`, `proj ls|rm` (project name after `proj rm`), `completion bash|zsh`, the alias-name suggestions after `alias`, `status --all/--json`, `logs --engine`, and the `lane add` option flags.
- **Dynamic project/lane names** — scanned live from `${ADDE_HOME:-~/.config/adde}` (no `adde` process is spawned): a project name at the first position of `up`/`down`/`restart`/`status`/`doctor`/`logs`/`sessions` and `lane ls|show|rm|add` (e.g. `adde up <TAB>`, `adde status <TAB>`), and a lane name at the next position (e.g. `adde logs <proj> <TAB>`, `adde lane show <proj> <TAB>`, `adde sessions <proj> <TAB>`).
- **Enum flag values** — after `--source` (markdown|telegram), `--perm-tier` (acp|autopass), `--file-mode` (private|shared), `--lang` (en|ko).
- **Directory paths** — after `--cwd` and `--root`.

An unsupported shell gives an error + exit code 1.

## Help and typo hints

- `adde <command> --help` (or `-h`) — prints that command's usage and exits with code 0. `adde lane <sub> --help` prints the full lane options.
- An **unsupported command** (typo, etc.) prints `Unknown command` + a nearest-command guess (`Did you mean: …?`) to stderr and exits with code 1 (prevents a typo from silently succeeding in a script).
- An **unsupported flag** — one not declared for that command (or subcommand) — prints an error + that command's usage (or the overall usage, if no command was recognized) to stderr and exits with code 1, e.g. `adde doctor --nonsense` (`[behavior-change]` — previously such flags were silently ignored and the command proceeded normally).

## Exit codes

| Command      | 0                                                       | 1                                                                                                                                               |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`         | Daemon registration succeeded                           | launchd registration failure · missing argument                                                                                                 |
| `down`       | Daemon stop succeeded (0 even if already gone)          | Error occurred                                                                                                                                  |
| `restart`    | down+up succeeded and every lane started                | down/up failed, or one or more lanes failed to start (`[behavior-change]` — previously always 0 as long as re-registration itself didn't throw) |
| `status`     | All healthy                                             | A `dead` (crash) / `stale` (hung) / `error` lane exists, **or the project has a crash-loop self-halt (`halt`)**                                 |
| `doctor`     | No FAIL (same with `--json`)                            | A FAIL item exists (same with `--json`)                                                                                                         |
| `logs`       | Read succeeded (0 with an info message even if no file) | Missing project/lane argument · path-validation error                                                                                           |
| `init`       | Wizard completed                                        | Non-TTY · missing argument · validation/creation error                                                                                          |
| `alias`      | Aliases installed · already-set confirmed               | `adde` not found in PATH · install failed                                                                                                       |
| `lane *`     | Success                                                 | Missing argument · validation error                                                                                                             |
| `completion` | Script output                                           | Missing shell argument · unsupported shell                                                                                                      |

Running with no arguments, or `-h`/`--help`/`help`, prints usage and returns `0`. An **unsupported command** (typo, etc.) prints `Unknown command` to stderr and returns `1` (prevents a typo from silently succeeding in a script).

## Language (locale)

CLI output and channel messages support two languages, en/ko.

- **Decision order**: `ADDE_LANG` (explicit) > `LC_ALL` > `LC_MESSAGES` > `LANG` (language-code parsing, `ko*`→Korean) > default **English**. On Korean macOS (`LANG=ko_KR.UTF-8`), output is in Korean without any extra setting.
- **Per-lane channel language**: `adde lane add --lang <en|ko>` (or conf `lang=`) can fix the language of that lane's channel messages (permission prompts, warning banner, notice notes). If unset, it follows the daemon process's global locale.
- **Note (launchd daemon)**: a daemon launched by launchd may not inherit the shell's `LANG` — to be sure of the channel-message language, set `lang=` in the lane conf.

## Paths

- Config base: `~/.config/adde` (changeable via the `ADDE_HOME` env var).
- Project: `<base>/<proj>/`.
- Lane conf: `<base>/<proj>/lanes.d/<lane>.conf`.
- Lane state: `<base>/<proj>/state/<lane>/` (`.env` · `session.id` · `sessions.json` (session ledger) · `transcript.log` · `engine.log` · `runtime.json`).
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist` (macOS only, created/managed by `adde up`).

## macOS-only features

The daemon-management features of `adde up`/`down`/`restart` depend on macOS launchd. On Linux/WSL these commands return an error.

**Reboot auto-recovery**: a daemon registered with `adde up` is always restarted after a macOS reboot/logout (`RunAtLoad`, regardless of `proj.conf`'s `auto_restart`). Crash auto-restart (`KeepAlive`, a non-zero exit or fatal signal) is separate and throttled to once every 60 seconds — see [crash-only auto-restart](#up--start-lanes-daemon) and [`proj.conf`](#projconf--daemon-crash-auto-restart). Confirming recovery yourself with `adde status <proj>` after a reboot is recommended.

**Operational verification checklist**: the items below are outside the automated verification scope and must be confirmed directly on a real macOS environment.

1. `adde up <proj>` → close the terminal → confirm `adde status <proj>` is `running` in a new terminal
2. `adde down <proj>` from another terminal, then confirm `adde status <proj>` is `stopped`
3. After a macOS reboot, `adde status <proj>` — confirm auto-recovery
4. Run `adde up <proj>` twice in a row — confirm no double start (warning printed, then skipped)
5. `adde down <proj>` then `ps aux | grep claude-agent-acp` — confirm no orphan process
6. Send a manual `SIGTERM` to the daemon process and let it complete its graceful shutdown — confirm launchd does **not** restart it (distinct from a `kill -9`/crash, which should restart it)
7. Set `auto_restart=false` in `proj.conf`, then crash the daemon (e.g. `kill -9`) — confirm launchd does not restart it and `adde status`/`adde doctor <proj>` surface it as registered-but-not-running (not a false `running`)
8. Point every lane's conf at an invalid/missing config so the daemon boots with zero running lanes — confirm it exits cleanly instead of looping, and that `adde up <proj>` reports the failure
9. Force repeated short-lived crashes on boot (5+ in a row, each under a minute) — confirm the daemon self-halts and `adde status`/`adde doctor <proj>` report it, then confirm `adde restart <proj>` clears the halt and lets it boot normally again
