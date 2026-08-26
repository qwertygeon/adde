_English | [한국어](troubleshooting.ko.md)_

# Troubleshooting

Diagnosis and remedies by symptom. Three commands narrow down most issues first:

- `adde doctor [<proj>]` — static check of environment/config (works even before startup).
- `adde status <proj>` — whether a session is active / hibernated / detached / archived.
- `adde logs <proj> <sid>` — recent session activity (conversation event record); add `--engine` for the engine's own diagnostic output, or `--daemon` for the daemon-level log.

## Table of Contents

- [Issues right after install (npm)](#issues-right-after-install-npm)
- [Won't start](#wont-start)
- [Session shows as detached](#session-shows-as-detached)
- [Engine crash & self-recovery](#engine-crash--self-recovery)
- [Crash safety & log rotation](#crash-safety--log-rotation)
- [Recovery after reboot / orphan cleanup](#recovery-after-reboot--orphan-cleanup)
- [No response after sending a message](#no-response-after-sending-a-message)
- [Failure notice after session control (clear/compact/resume)](#failure-notice-after-session-control-clearcompactresume)
- [Permissions](#permissions)
- [Telegram/Discord](#telegramdiscord)
- [Markdown-only](#markdown-only)
- [v0.2.x data present](#v02x-data-present)

## Issues right after install (npm)

| Symptom                                        | Cause                                             | Remedy                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `adde: command not found`                      | The global bin isn't on PATH                      | Check that the `npm bin -g` path is on PATH                                                                |
| `ad`/`add` short aliases missing               | Not installed by default (opt-in)                 | `adde alias` (or `adde init`) — [command reference](commands.md#alias--install-short-aliases)              |
| `EACCES` on install                            | Root-owned Node prefix                            | Use a version manager (nvm/fnm) or a user npm prefix instead of `sudo`                                     |
| `adde --version` works but no session comes up | Claude unauthenticated / engine handshake failure | Confirm Claude (Claude Code) is authenticated under the same user. Check `adde logs <proj> <sid> --engine` |
| `env: node: No such file` in engine log        | node not on launchd's minimal PATH                | `adde restart <proj>` (re-injects PATH into the plist)                                                     |

## Won't start

Run `adde doctor <proj>` first.

| Symptom                                       | Cause                                                                                         | Remedy                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `doctor` FAILs the ACP adapter / engine check | Engine driver not installed/registered                                                        | Retry after `pnpm install`; check `adde doctor` global "engines" line                               |
| Node version FAIL                             | Node < 22                                                                                     | Upgrade to Node 22+                                                                                 |
| No project exists                             | No project created yet                                                                        | `adde project add <proj> --vault <path>` (or `adde init`)                                           |
| `project.conf` FAIL                           | Config file unreadable                                                                        | Check `~/.config/adde/projects/<proj>/project.conf` exists and is readable                          |
| vault WARN                                    | Vault path doesn't exist yet                                                                  | It's created on first use — this is informational, not blocking                                     |
| `doctor` launchd registration mismatch WARN   | plist existence vs launchctl registration mismatch                                            | `adde down <proj>` then `adde up <proj>`                                                            |
| `doctor` daemon entry-file WARN               | Trying to daemonize from a dev checkout without a build                                       | `pnpm build`, then `node dist/cli/adde.js up <proj>` (or a global install)                          |
| `doctor` legacy-collision FAIL                | A v0.2.x project happened to be named `projects` — collides with v2's reserved container name | See [v0.2.x data present](#v02x-data-present) — v0.2.x data is untouched either way                 |
| Startup fails on engine handshake no-response | Engine stalls with no response                                                                | Confirm the engine binary/auth, then `adde restart <proj>`; check `adde logs <proj> <sid> --engine` |

## Session shows as detached

`adde status` reports `detached` when a session's engine resume failed at boot, or when repeated engine crashes exhausted self-recovery (see below). Unlike `hibernated` (intentionally idle, resumes transparently), `detached` needs your attention.

```bash
adde logs <proj> <sid> --engine   # see the recorded failure reason
adde restart <proj>                # or, from the channel, check the resume palette marker
```

## Engine crash & self-recovery

If a session's **engine** process (not the daemon) crashes after the handshake, ADDE detects it and by default relaunches it automatically — same session (`engineRef`), same subscribers, same permission handler — with a bounded exponential backoff (starts at 1s, doubles each attempt, capped at 30s between attempts, up to 5 attempts; a session that stays healthy for 60s resets the counter). While retrying, `adde status` may show the session as still `active` with a stale heartbeat rather than immediately `detached` — this is expected during the retry window.

If every attempt fails, ADDE marks the session `detached` and sends a one-time channel notice. Any permission approval still pending at crash time is denied immediately (fail-closed) rather than left to time out.

- **Recovering after a give-up**: `adde restart <proj>`, or the channel's `♻️ resume` palette marker.
- **Turning self-recovery off**: `adde project set <proj> auto_relaunch false`, then `adde restart <proj>`. With it off, ADDE still detects the crash, denies pending approvals, and sends a one-time notice, but marks the session `detached` immediately instead of retrying.
- Intentional restarts (`adde restart`, `clear`, `resume`) are unaffected — self-recovery only reacts to _unexpected_ engine exits.

## Crash safety & log rotation

The section above covers a session's **engine** process. The **daemon** process itself (the launchd-managed worker hosting all of a project's sessions) has a separate, project-level safety net.

- **Crash-loop self-halt**: 5 or more short-lived daemon crashes in a row (each surviving under a minute) trips a self-halt — the daemon stops retrying and records the cause/time instead of looping forever. `adde status`/`adde doctor <proj>` report it; `adde restart <proj>` clears the halt record.
- **Log rotation**: the engine diagnostic log (`--engine`) rotates by size; the conversation event record (the default `adde logs` view) is **never rotated or deleted** — it's the durable original. The launchd daemon log (`--daemon`) is trimmed on next (re)load, not while running.
- Daemon crash auto-restart is controlled by the project's `auto_restart` key (default on) — see [command reference](commands.md#up--down--restart--daemon-control).

## Recovery after reboot / orphan cleanup

- **Project isn't up after a reboot/logout**: a daemon registered with `adde up` always auto-recovers via `RunAtLoad`, and every session that was `active` auto-resumes. Confirm with `adde status <proj>`; if it's not as expected, check `adde doctor <proj>` then `adde up <proj>`.
- **Orphan engine process**: after `adde down <proj>`, check for leftovers with `ps aux | grep claude-agent-acp` — the daemon does not force-kill by stored pid (pid-reuse risk), so an abnormal exit can occasionally leave one behind.

## No response after sending a message

1. Confirm `adde status <proj>` shows the session as `active` (or `hibernated` — it resumes transparently on the next turn).
2. Check whether the message was received/processed with `adde logs <proj> <sid>`.
3. Responses arrive **all at once at turn end** (no streaming during progress) — wait a moment for a long-running turn.

## Failure notice after session control (clear/compact/resume)

From the channel palette, `clear`/`resume` restart or resume the engine. If that fails (spawn error, handshake no-response), a failure notice arrives and the session may remain `detached`.

- Remedy: `adde restart <proj>`.
- Then check the cause with `adde doctor <proj>` and `adde logs <proj> <sid> --engine`.
- `compact` delegates to the in-progress engine session without a restart, so it doesn't fall in this path.

## Permissions

> Conceptual explanation (tiers, denylist, hard-deny) is in the [permissions guide](permissions.md). Below are remedies by symptom.

- **Always denied**: no response within the gate timeout (default 600s) auto-denies (fail-closed). A tool refused immediately with no approval note at all matched `hard_deny` (or `--safe-defaults`) — check `hard_deny` in `adde project show <proj>`.
- **Permission-drift warning at startup**: the engine's effective permissions are looser than ADDE's policy (e.g. it bypasses its own checks) — align the engine's own permission settings with `perm_tier`. Under `autopass` with a bypassing engine, no permission requests arrive at all, so `denylist` has no effect.
- **Approvals too frequent**: `adde project set <proj> --add-allow Read,Grep` (or the opt-in `autopass` tier with a `denylist`) — see the [permissions guide](permissions.md).

## Telegram/Discord

Not implemented in this release — see [telegram.md](telegram.md). Binding creation for these surfaces is refused; the only working channel is [markdown](markdown.md).

## Markdown-only

| Symptom                                              | Check                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checked but not sent                                 | The send box is checked (`[x]`), body between `<!-- adde:compose -->` and the send box is not empty                                                                                              |
| Session doesn't respond                              | Whether the vault path exists · `adde status <proj>` shows the session `active`/`hibernated` (not `detached`)                                                                                    |
| Turn note not visible                                | Check `turns/` under the session's vault folder, and whether the turn has actually ended                                                                                                         |
| Turn note not where expected                         | If retention is enabled (`vault.backup`), a note older than `vault.retention_days` moved to `<backup>/<turn-start-date>/...` — see [markdown guide](markdown.md#vault-lightness-retention--sync) |
| Project creation refused ("backup overlaps ...")     | `vault.backup` overlaps the vault or ADDE's config root — point it elsewhere                                                                                                                     |
| Project creation refused (unsupported sync provider) | `vault.sync_provider` must be `local` or `icloud`                                                                                                                                                |

Detailed setup: [Markdown guide](markdown.md).

## v0.2.x data present

`adde doctor` reports (`INFO`) when it finds a v0.2.x layout (`~/.config/adde/<proj>/lanes.d/`) — **it is never read or modified**. This is informational only; v2 uses a physically separate config root (`~/.config/adde/projects/<proj>/`). If a v0.2.x project happened to be named `projects`, `doctor` reports a `FAIL` name collision (v2 reserves that name for its own container directory) — again, no v0.2.x data is touched. There is no automatic migration to a v2 project/session yet.
