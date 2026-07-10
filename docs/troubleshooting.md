_English | [한국어](troubleshooting.ko.md)_

# Troubleshooting

Diagnosis and remedies by symptom. Two commands narrow down most issues first:

- `adde doctor [<proj>]` — static check of environment/config (can run even before startup).
- `adde status <proj>` — whether a lane is running / dead / stopped.
- `adde logs <proj> <lane>` — recent session activity.

## Table of Contents

- [Issues right after install (npm)](#issues-right-after-install-npm)
- [Won't start](#wont-start)
- [Lane shows as dead](#lane-shows-as-dead)
- [Lane shows as stale (hung)](#lane-shows-as-stale-hung)
- [Engine crash & self-recovery](#engine-crash--self-recovery)
- [Crash safety & log rotation](#crash-safety--log-rotation)
- [Recovery after reboot / orphan cleanup](#recovery-after-reboot--orphan-cleanup)
- [No response after sending a message](#no-response-after-sending-a-message)
- ["Delivery uncertain" notice after an interrupted send](#delivery-uncertain-notice-after-an-interrupted-send)
- [Failure notice after session control (clear/resume)](#failure-notice-after-session-control-clearresume)
- [Permissions](#permissions)
- [Telegram-only](#telegram-only)
- [Markdown-only](#markdown-only)

## Issues right after install (npm)

Issues you hit right after `npm i -g adde-acp`, before starting a lane.

| Symptom                                     | Cause                                               | Remedy                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adde: command not found`                   | The global bin isn't on PATH                        | Check that the `npm bin -g` path is on PATH. If using a user prefix, add `~/.local/bin` (or your configured prefix) to PATH                                                                     |
| The `ad`/`add` short aliases are missing    | Short aliases are not installed by default (opt-in) | Install with `adde alias` (or `adde init`). If a command of the same name already exists, it is skipped rather than overwritten — [command reference](commands.md#alias--install-short-aliases) |
| `EACCES` permission error on install        | Root-owned Node prefix                              | Use a version manager (nvm/fnm) or a user prefix (`npm config set prefix ~/.local`) instead of `sudo` — [Getting started install section](getting-started.md#install)                           |
| `adde --version` works but no lane comes up | Claude unauthenticated / engine handshake failure   | Confirm Claude (Claude Code) is authenticated and works under the same user (`ANTHROPIC_API_KEY` or login). Check engine stderr with `adde logs <proj> <lane> --engine`                         |
| `env: node: No such file` in engine log     | node not on launchd's minimal PATH                  | Run `adde restart <proj>` (re-injects the plist PATH) with `node`'s install location on PATH. See "Won't start" below                                                                           |

## Won't start

Run `adde doctor <proj>` first to check `FAIL`/`WARN`.

| Symptom                                     | Cause                                                                                  | Remedy                                                                                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor` FAILs the ACP adapter binary       | Engine adapter not installed                                                           | Retry after `pnpm install` (e.g. installs `@agentclientprotocol/claude-agent-acp`)                                                                                                                                                                                    |
| Node version FAIL                           | Node < 22                                                                              | Upgrade to Node 22 or higher                                                                                                                                                                                                                                          |
| `no conf in lanes.d`                        | No lane created                                                                        | Create with `adde lane add <proj> <lane> ...` (or `--interactive` / `adde init`)                                                                                                                                                                                      |
| Token FAIL (telegram)                       | No token in `.env`                                                                     | Store the token per [Telegram guide step 4](telegram.md#4-store-the-bot-token)                                                                                                                                                                                        |
| cwd FAIL/warning                            | Working folder missing                                                                 | Create the folder or fix `cwd` in the conf                                                                                                                                                                                                                            |
| `doctor` file-permission WARN               | `.env` is not 0600, or `file_mode=private` but the state dir is group/other-accessible | Per the remedy hint, `chmod 600 .../.env` (or `chmod 700 state/<lane>`), then `adde restart <proj>`. `shared` mode is an intentional choice and not warned                                                                                                            |
| `doctor` launchd registration mismatch WARN | plist existence vs launchctl registration mismatch                                     | Clean up with `adde down <proj>`, then re-register with `adde up <proj>`                                                                                                                                                                                              |
| `doctor` daemon entry-file WARN             | Trying to daemonize from dev without a build                                           | After `pnpm build`, `node dist/cli/adde.js up <proj>` or global install (`npm i -g .`) — same cause as "daemon registered but lane doesn't come up" below                                                                                                             |
| Startup fails on handshake no-response      | Engine stalls with no response                                                         | Confirm the engine binary/health, then retry `adde up` (ADDE times out after 30s and cleans up the child). If `adde logs <proj> <lane> --engine` shows `env: node: No such file or directory`, it's a PATH problem — see "daemon-launched lane doesn't come up" below |
| Daemon registered but lane doesn't come up  | Daemonized via `pnpm run dev up` without a build                                       | The daemon worker is a separate process launched by launchd, so tsx (dev) won't work. After `pnpm build`, start with `node dist/cli/adde.js up <proj>`, or global install (`npm i -g .`) then `adde up <proj>` (without a build, `adde up` refuses with guidance)     |

## Lane shows as dead

In `adde status`, `dead` means the launched process exited abnormally (crashed) but the state file remains.

```bash
adde down <proj>   # clean up leftover state
adde doctor <proj> # check the cause
adde up <proj>     # restart
```

Checking activity just before exit with `adde logs <proj> <lane>` helps identify the cause.

## Lane shows as stale (hung)

In `adde status`, `stale` means the launched process (pid) is alive but the heartbeat (state-file mtime) has stopped past a threshold — **suspected hung**. Unlike a crash (`dead`), the process remains, so the remedy differs.

```bash
adde logs <proj> <lane> --engine   # engine stderr — see what it's blocked on
adde restart <proj>                # recover by restarting the daemon
```

A common cause of a hang is the engine being tied up in a long task / external wait, or its response stopping. If a restart doesn't clear it, check the environment with the `--engine` log and `adde doctor <proj>`.

## Engine crash & self-recovery

If a lane's **engine** process (not the daemon itself) crashes after the handshake, ADDE detects it and, by default, relaunches it automatically — carrying over the same session, subscribers, and permission handler, so a single crash doesn't require a manual restart. While it's retrying (bounded exponential backoff, capped attempts), `adde status` may briefly show `stale` (the heartbeat is intentionally held back so a crashed-and-retrying lane isn't misreported as `running`). If every attempt fails, ADDE gives up, marks the lane `error`, and sends a one-time channel notice:

```
🛑 lane <lane> auto-recovery gave up after <N> attempts — status set to error. Recover with adde restart <proj>.
```

Any permission approval still pending at crash time is denied (fail-closed) rather than left to time out — the channel does not hang waiting for the full approval timeout.

- **Recovering after a give-up**: `adde restart <proj>` (or `/clear`/`/resume` from the channel).
- **Turning self-recovery off**: add `auto_relaunch=false` to the lane's `.conf` (not a `lane add` flag — edit the file, then `adde restart <proj>`). With it off, ADDE still detects the crash, denies pending approvals, and sends a one-time notice, but marks the lane `error` **immediately** instead of retrying:
  ```
  🛑 engine crashed on lane <lane> — auto-relaunch is off (auto_relaunch=false); status set to error, no restart attempted. Recover with adde restart <proj>.
  ```
- Intentional restarts (`adde restart`, `/clear`, `/resume`) are unaffected — self-recovery only reacts to _unexpected_ engine exits, and disarms itself during a deliberate restart so the engine isn't double-started.

## Crash safety & log rotation

The section above covers a lane's **engine** process. The **daemon** process itself (the launchd-managed worker that hosts all of a project's lanes) has a separate, lower-level safety net.

- **Unhandled daemon errors**: an uncaught exception in the daemon worker is logged with secrets masked and the daemon exits (after a bounded, 5-second cleanup attempt) so launchd can restart it — see the crash-only auto-restart semantics below. An unhandled promise rejection, by contrast, is logged and absorbed instead of exiting, so a single stray rejection doesn't take the whole daemon down (repeats of the same cause are rate-limited to about once a minute in the log so they don't flood it).
- **Log growth**: `transcript.log` and `engine.log` rotate once they reach 5MB (2 generations kept, oldest dropped), so a 24-hour resident daemon's logs stay bounded instead of eventually filling the disk (which would otherwise start failing every write — queue, output, runtime state, session ledger). `adde logs <proj> <lane>` keeps working across rotations. The launchd daemon log (`.out`/`.err.log`, `adde logs <proj> --daemon`) isn't rotated while running (launchd holds it open) but is trimmed to its last ~5MB when the daemon is next (re)loaded.

| Symptom | Cause | Remedy |
|---|---|---|
| Daemon used to restart itself even right after a clean `adde down` or a manual stop | Previously `KeepAlive` was unconditional, so **any** exit (including a clean one) was relaunched; this is now fixed — a graceful stop exits cleanly and is not restarted | No action needed. If an older registration still shows this, `adde restart <proj>` to apply the current plist |
| `adde up`/the daemon used to loop restarting every ~10s right after a config problem (e.g. zero lanes) | Previously a deterministic boot failure exited non-zero and got relaunched forever; this is now fixed — that kind of boot failure exits cleanly instead of looping (the failure is still reported by `adde up`, it's just not auto-retried) | Fix the underlying config (see the failure reason `adde up` printed), then `adde up <proj>` again |
| `adde status`/`adde doctor <proj>` reports the daemon has **self-halted** | Repeated short-lived crashes right after boot (5 or more in a row, each surviving under a minute) tripped the crash-loop safety net, which stops retrying and records the halt cause/time instead of retrying forever | Check the reported cause, fix it, then `adde restart <proj>` — this clears the halt record and lets the daemon go through a normal boot again |
| Daemon crashed and stayed down instead of auto-restarting | `proj.conf` has `auto_restart=false` for this project — see [command reference](commands.md#projconf--daemon-crash-auto-restart) | Expected with this setting; `adde restart <proj>` (or `adde up <proj>`) to bring it back up, or remove/flip the setting if you want launchd to auto-restart crashes again |

## Recovery after reboot / orphan cleanup

- **Lane isn't up after a reboot/logout**: a daemon registered with `adde up` always auto-recovers via `RunAtLoad` regardless of `proj.conf`'s `auto_restart` (that setting only affects crash restarts, not reboot recovery), but confirm the actual status yourself — if `adde status <proj>` isn't `running`, check `adde doctor <proj>` (including registration status) then restart with `adde up <proj>`. The plist holds the PATH from the time of `adde up`, so if you later moved node/claude's install location, refresh the PATH with `adde restart <proj>`.
- **Orphan engine process**: a `claude-agent-acp` engine process can linger after an abnormal exit. After `adde down <proj>`, check for leftovers with `ps aux | grep claude-agent-acp`, and if any remain, terminate that pid.

## No response after sending a message

1. Confirm `adde status <proj>` shows the lane as `running` (otherwise go to the items above).
2. See whether the message is received/processed with `adde logs <proj> <lane>`.
3. If the AI turn is long, the response comes **all at once at turn end** (no streaming during progress). Wait a moment.
4. If message-queue enqueuing fails repeatedly due to a full disk or a permission problem, ADDE sends an "enqueue failed N times in a row" alert to the operator channel — check disk capacity and the `state` directory's permissions.

## "Delivery uncertain" notice after an interrupted send

In a **Telegram (chat)** lane, you may occasionally see a one-time notice like this:

> ⚠️ The process was interrupted mid-send — delivery of this reply (id …) is uncertain. It will not be resent, to avoid duplicates. If it didn't arrive, please ask again.

In plain terms:

- ADDE had finished preparing an answer and was in the middle of sending it to your chat when the process was interrupted (for example, the daemon restarted at exactly that moment).
- Because ADDE can't be sure whether that message actually reached you, it deliberately **does not send it again**. This prevents the earlier problem where you could receive the same answer twice.
- The answer may or may not have arrived. **If it didn't show up, just send your request again** — that's the only action needed.
- Nothing is broken and there is nothing to configure; this is normal crash-safety behavior.
- This applies to **Telegram (chat) lanes only**. Markdown (note) lanes are unaffected — re-writing the same note is harmless, so they simply finish delivering with no duplicates.

## Failure notice after session control (clear/resume)

From the channel, `/clear` or `/resume` **restarts** the engine as a new session. If the restart fails (engine spawn error, handshake no-response, etc.), a `🛑 session control failed — engine restart error` notice arrives on the channel, and that lane's engine may remain down.

- Remedy: recover the lane by restarting the daemon with `adde restart <proj>`.
- Then check the restart-failure cause with `adde doctor <proj>` (engine adapter / environment check) and `adde logs <proj> <lane> --engine` (engine stderr).
- `/compact` delegates the compact command to the in-progress session without a restart, so it doesn't fall in this path.

## Permissions

> The conceptual explanation of the permission model, tiers, denylist, and hard-deny is in the [permissions guide](permissions.md). Below are remedies by symptom.

- **Always denied**: if you don't respond to a permission request in time (default 10 minutes), it auto-denies fail-closed. Channel-delivery failure or error is also treated as deny. If a specific tool is refused immediately without even an approval prompt, it matched `hard_deny` (or the `--safe-defaults` danger list) — check `hard_deny=` in the conf.
- **Permission-drift warning at startup**: if the engine's effective permissions are found looser than ADDE's policy (e.g. bypassPermissions), a warning is shown on the console, channel, and transcript, and startup continues. In this state the gate can be neutralized, so disable the engine's permission setting or align it with the conf `perm_tier`. In particular, an `autopass` lane where the engine bypasses gets no permission requests at all, so the denylist doesn't work.
- **Approvals too frequent**: registering frequently used safe tools like `--allowlist Read,Grep` stops them from being asked each time (the gate itself stays on, recorded in the transcript). Don't add broad tools like `Bash` or file writes (self-approval risk). If you want to auto-allow most things, consider the opt-in `--perm-tier autopass --denylist Bash,Write` (only the denylist is confirmed) — see the [command reference](commands.md#lane-add-options).

## Telegram-only

| Symptom                                | Check                                                                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No response                            | Whether `chat_id` is set in the conf (rendering is skipped if unset)                                                                                                                                  |
| Sent but ignored (unauthorized in log) | The sender is outside the allow list. Add the sender's user/chat id to `chat_id` (own chat auto-allowed) or `allow_from`. If unset, all denied (fail-closed) — engine log shows `unauthorized sender` |
| Token format warning                   | Whether the BotFather-issued token is in `<digits>:<alphanumeric>` format                                                                                                                             |
| Bot doesn't receive messages           | Whether the token is correct and the bot isn't blocked                                                                                                                                                |

Detailed setup: [Telegram guide](telegram.md).

## Markdown-only

| Symptom                                 | Check                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checked but not sent                    | inbox path matches, the send box is checked (`[x]`), body not empty                                                                                                                        |
| Lane doesn't come up                    | Whether the `root` absolute path actually exists (fail-closed if not) · whether the inbox/approvals/outbox paths don't overlap (startup refused if equal or in a containment relationship) |
| Startup refused (control-note location) | Whether inbox/approvals/outbox are **outside** `cwd` (refused with self-approval risk if inside)                                                                                           |
| Response note not visible               | Check the `outbox` path, and whether the AI turn has ended (idle)                                                                                                                          |
| Output note / decided approval not where expected | Look for a `YYYY-MM-DD/` subfolder underneath (date-partitioned by send/decision time, applied even without `markdown.backup`) — or, if `markdown.backup` is configured, in the backup folder for anything older than `retention_days` |
| Startup refused ("backup path overlaps ...") | `markdown.backup` overlaps the vault or ADDE's internal state folder — point it somewhere else (outside the vault, no shared ancestor) |
| Startup refused ("unsupported sync_provider") | `markdown.sync_provider` must be `local` or `icloud` (leave it unset for `local`) |
| Startup refused ("out_retention_days ... must be >= retention_days ...") | `markdown.out_retention_days` must be at least `retention_days + 1` — raise it or unset it |
| "backup relocation is on but archive is not configured" warning | `markdown.backup` is set but `markdown.archive` isn't — set an archive directory too if you also want sent text relocated (otherwise inbox text keeps accumulating) |

Detailed setup: [Markdown guide](markdown.md#keeping-the-vault-light-retention--backup-relocation).
