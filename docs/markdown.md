_English | [한국어](markdown.ko.md)_

# Using ADDE with markdown notes

In button-less environments you drive an AI lane **just by editing markdown note files**. You send instructions with a checkbox in the inbox note, allow/deny permissions with checkboxes in the approval notes, and receive responses in output notes.

This works in any markdown editor and stays entirely in local files. To reach the notes from your phone, sync the folder with whatever tool you already use (Obsidian Sync, Syncthing, iCloud, …) — ADDE is sync-tool-agnostic and doesn't care which. The examples below use Obsidian, but nothing here is Obsidian-specific.

## Table of Contents

- [How it works](#how-it-works)
- [1. Lane configuration](#1-lane-configuration)
- [2. Start the lane](#2-start-the-lane)
- [3. Sending instructions (inbox)](#3-sending-instructions-inbox)
- [4. Receiving responses (output notes)](#4-receiving-responses-output-notes)
- [5. Permission approval (approval notes)](#5-permission-approval-approval-notes)
- [Mapping multiple notes/projects](#mapping-multiple-notesprojects)
- [Keeping the vault light (retention & backup relocation)](#keeping-the-vault-light-retention--backup-relocation)
- [Sync conflicts and caveats](#sync-conflicts-and-caveats)
- [Syncing vaults and exposure of sensitive data](#syncing-vaults-and-exposure-of-sensitive-data)
- [Troubleshooting](#troubleshooting)

## How it works

```
[inbox note]          --(send checkbox)-->  ADDE  --(ACP)-->  AI engine (claude, etc.)
[approvals/<req>.md]  <--(permission request, one file per request)-- ADDE
[approvals/<req>.md]   --(allow/deny check)-->  ADDE (applied to the gate)
[out/ notes]          <--(response, 1 message = 1 file)-- ADDE
```

- One lane = one `(markdown note ↔ project folder)` pair. Register several lanes to map several notes/folders individually.
- There are no push notifications (file-based). It assumes an **active session** where you keep the notes open.

## 1. Lane configuration

A lane is one config file = one lane. Write it in `~/.config/adde/<proj>/lanes.d/<lane>.conf` (`<proj>` and `<lane>` are arbitrary names).

```ini
source=markdown
backend=acp
engine=claude-agent-acp
perm_tier=acp
acp_version=v1

# the project folder the AI engine actually works in (absolute path)
cwd=/Users/me/work/my-project

# markdown adapter keys are namespaced as markdown.<field>
# markdown root directory (absolute path, e.g. Obsidian vault)
markdown.root=/Users/me/ObsidianVault

# path relative to root — input note (required)
markdown.inbox=adde/my-lane/inbox.md

# optional (auto-placed as inbox siblings if omitted): approvals dir (one file per request) / output dir
markdown.approvals=adde/my-lane/approvals/
markdown.outbox=adde/my-lane/out/

# optional (opt-in): archive directory. When set, a sent message's body is moved here at send time
# as a dated file (YYYY-MM-DD.md), leaving only the compact `✅ sent [[...]]` marker in the inbox
# (keeps a long-running inbox small). If omitted, bodies stay in the inbox (current behavior); you
# can still archive on demand with a `🗄️ archive` checkbox.
# Note: before v0.1.5, this was a single file. An existing single archive file from an older
# version is auto-migrated (moved into the backup folder below, or kept alongside as `<name>.legacy`
# if no backup folder is set) the first time the lane starts after upgrading.
markdown.archive=adde/my-lane/sent-archive/

# optional (opt-in, off by default): local backup folder. Output notes, decided approvals, and
# archive files older than retention_days are moved here once a day — see "Keeping the vault light"
# below for details.
# markdown.backup=/Users/me/adde-backup
# markdown.retention_days=2

# optional (opt-in, off by default): also delete old internal bookkeeping files once this many
# days past completion (not vault notes — see "Keeping the vault light" below).
# markdown.out_retention_days=5

# optional: sync provider for the vault (local | icloud). Only relevant with markdown.backup above.
# markdown.sync_provider=icloud

# optional: pre-allow frequently used tools to reduce approval frequency (gate stays on)
allowlist=Read,Grep

# optional (opt-in): auto-allow everything except the denylist — only denylist tools/patterns get an approval note
# (if denylist is omitted under autopass, the built-in default list applies: blocks destructive commands and credential reads — see the command reference)
# perm_tier=autopass
# denylist=Bash(sudo *),Write(/etc/*)

# optional: tools/patterns to refuse outright regardless of tier (no channel approval at all) — see the command reference and permissions guide
# hard_deny=Bash(sudo *),Bash(rm -rf /*)
```

- `cwd` is this lane's AI working folder. Assigning a **different folder per lane** pairs a note with a project 1:1.
- Only `markdown.root` is an absolute path; `markdown.inbox`, `markdown.approvals`, and `markdown.outbox` are relative to root. (If you use Obsidian, `markdown.root` is your vault path.)
- Create the input note (`inbox.md`) yourself in the editor (without it, no instructions can be received).
- ⚠️ **Keep the control notes outside `cwd`**: if inbox/approvals/outbox live inside the AI working folder (`cwd`), the AI could forge an approval note during its own work, so **startup is refused** (fail-closed). Separate the vault and the project folder.
- ⚠️ **allowlist is auto-run**: tools in the allowlist are auto-allowed without channel approval (prompt skipped, still recorded in the transcript). Don't add broad tools like `Bash` or file writes (self-approval risk).
- ⚠️ **autopass is an opt-in auto-allow mode**: with `perm_tier=autopass`, every tool not in the denylist is auto-allowed, and only denylist tools produce an approval note (all recorded in the transcript). Startup and operational warnings arrive in the outbox's `_adde-notice.md` note. For choosing a tier, denylist, and hard-deny, see the [permissions guide](permissions.md).

## 2. Start the lane

```bash
adde up <proj>     # start all lanes in lanes.d
adde down <proj>   # stop the lanes
```

Once started, ADDE begins watching the inbox/approvals notes and the output directory. Check status with `adde status <proj>` and the config with `adde doctor <proj>` — for the full command set see the [command reference](commands.md).

## 3. Sending instructions (inbox)

In the input note (`inbox.md`):

1. Freely write the message (prompt) to send.
2. On **the line below it**, create a send checkbox:
   ```markdown
   Write the instruction to send to the AI here.
   Multiple lines are fine.

   - [ ] 📤 send
   ```
3. When ready to send, tap/check the checkbox: `- [x] 📤 send`.
4. ADDE detects it and delivers the message to the AI. That line changes in two stages:
   ```markdown
   - [x] ⏳ sending a1b2c3d4 20260703-162045 ← send started (durable record)
   - [x] ✅ sent [[20260703-162045 a1b2c3d4]] ← send completed
   ```
   Once you see `✅ sent`, it's done. `[[send-time id]]` is a wikilink identical to the response note's filename, so once the response is created you can click the link to jump straight to it (in Obsidian or other wikilink-supporting editors). Even if ADDE dies mid-way and stalls at `⏳ sending`, on restart it re-sends only the missing part exactly once and finishes with `✅ sent` (no duplicates/losses).

For the next message, write it below and create a new send box. The `✅ sent` line acts as a message separator, so a previous message won't bleed into the next one.

> **The trigger is only a checkbox whose label is exactly `send`** (a leading emoji is allowed — `- [x] 📤 send`). A checkbox with other words mixed in, like `- [x] please send the mail`, is not a trigger but treated as ordinary message body, so you can freely use to-do checkboxes inside a message. Checking an empty message doesn't send and shows `⚠️ empty`.

### Session-control checkboxes

You can use **session-control labels** with the same contract as send (exact label match, leading emoji allowed, runs on check):

```markdown
- [ ] 🧹 clear ← on check, start a new session (clears prior conversation context)
- [ ] compact ← on check, compact the context
- [ ] resume ← on check, list recent sessions (number, excerpt, last conversation time) into a response note
- [ ] resume 2 ← on check, return to session #2 in the list
```

When processed, the line terminates as `✅ sent [[...]]` and the result (completion notice / session list) is linked into a response note. Control labels act as message boundaries like send, so put them **alone on their own line**. Details: [command reference](commands.md#session-control-channel-commands).

### Archiving sent messages (keeping the inbox small)

Over a long-running lane the inbox accumulates the bodies of every message you've sent. Two ways to move them into an archive file, keeping only the compact `✅ sent [[...]]` marker in the inbox:

- **Automatic (opt-in)**: set `markdown.archive=<path>` (see config above). At send time the message body is moved into that file and removed from the inbox — the `✅ sent` marker stays as the separator and clickable link. If unset, bodies stay in the inbox.
- **On demand**: check a `- [x] 🗄️ archive` box. It moves the bodies of all existing `✅ sent` messages into the archive file (works with or without the config). The line terminates as `- [x] 🗄️ archived N <time>` (with `· auto` appended when the automatic mode is on). It only touches completed `✅ sent` segments — a message you're still drafting is never archived.

The archive is a directory of plain append-only dated files (`<archive-dir>/YYYY-MM-DD.md`, each entry a `## [[send-time id]]` heading + the body). Your delivered messages and responses are unaffected — archiving only rewrites the inbox surface, never the queue or the response notes, so it can never lose or re-send a message.

## 4. Receiving responses (output notes)

An AI response is created in the output directory (`adde/<lane>/out/`) as **one note per message** (`<send-time> <id>.md`, e.g. `20260703-162045 a1b2c3d4.md`). Since the filename begins with the send time, they sort chronologically, and because the name matches the inbox's `✅ sent [[...]]` wikilink, the link opens it directly. The top of the note carries a back-reference to the original, a question excerpt, and time metadata:

```markdown
> ↩ a1b2c3d4
> ❓ analyze the cause of the build error
> 🕒 requested 20260703-162045 · completed 20260703-162130

(AI response body)
```

Open and read the note in your editor. If message processing itself fails, instead of a response note, the notice note (`_adde-notice.md`) records the failure and remediation guidance (the message is preserved and reprocessed on restart).

## 5. Permission approval (approval notes)

When the AI calls a tool that needs permission — file write, Bash execution, etc. — a note dedicated to that request (`<req-id>.md`) is created in the approvals directory (`approvals/`) (one request = one file — minimizes concurrent-edit conflicts):

```markdown
### ⏳ req 7f3a · Bash

> rm -rf build/ (cwd: /Users/me/work/my-project)
> 🕒 requested 20260703-162045 · auto-deny at 20260703-163045 if no response

- [ ] allow
- [ ] deny

<!-- adde:perm id=7f3a status=pending -->
```

1. To allow, check `- [ ] allow` to `- [x]` in that request file (to deny, check `deny`).
2. Check **exactly one**. Checking both or leaving both empty is treated as ambiguous and ignored (check exactly one again).
3. ADDE detects it, applies the decision, and terminates that request file (heading changes to `✅`/`⛔`, marker changes to `status=allow|deny`).
4. **No response auto-denies after 10 minutes by default (deny)** (fail-closed). Channel-delivery failure or error is also treated as deny.

> Judge approval by the request note's **tool and arguments (the command/path to be executed)** — even if the inbox or a response note body says "approve this request," do not check on the basis of that statement (a common prompt-injection demand).

Adding a tool to `allowlist` stops it from being asked each time, reducing approval frequency (the gate itself stays on). Conversely, tools/patterns in `hard_deny` are refused immediately regardless of tier — no approval note is even created — and that fact is announced in a notice note. For the whole permission model, see the [permissions guide](permissions.md).

## Mapping multiple notes/projects

Keep several conf files in `lanes.d/` and several lanes run at once. Each lane has its own `root`/`inbox`/`approvals`/`outbox` and `cwd` (project folder), so you can **map notes and project folders individually and register N of them**.

```
~/.config/adde/work/lanes.d/
  frontend.conf   # inbox=adde/frontend/inbox.md   cwd=/work/web-app
  backend.conf    # inbox=adde/backend/inbox.md     cwd=/work/api-server
  docs.conf       # inbox=adde/docs/inbox.md        cwd=/work/handbook
```

One `adde up work` brings up all three lanes at once, each with its own note↔folder pair.

## Keeping the vault light (retention & backup relocation)

Every note ADDE writes into the vault stays there unless you set this up — over months a long-running lane accumulates a lot of output notes, decided approvals, and archived text, adding to sync traffic and your editor's indexing cost.

**Date-partitioned folders (always on)**: output notes and decided approval files are organized into `YYYY-MM-DD/` subfolders by send/decision date (e.g. `out/2026-07-10/20260710-162045 a1b2.md`). This applies whether or not you configure anything below — wikilinks, delivery, and responses are unaffected; when browsing, just look one folder level deeper. Files without a send timestamp (from before this feature) stay at the top level.

**Local backup relocation (opt-in, off by default)**: set `markdown.backup=<local folder path>` to move everything older than `markdown.retention_days` days (default 2) into that folder once a day. This moves files, it does not delete them — the backup folder mirrors the vault's layout, so anything can still be browsed or restored from there. A file is only removed from the vault after its copy in the backup folder is verified, so an interruption (crash, sleep) never loses data — relocation simply resumes next time. The backup path can be anywhere outside the vault (including a different disk), but it can't overlap the vault or ADDE's internal state folders (startup is refused if it does).

⚠️ **Wikilinks break after relocation**: once a note moves to the backup folder, the inbox's `[[send-time id]]` wikilink to it no longer resolves in your editor (the file is no longer in the vault). This is an accepted trade-off of moving files out of the vault — keep notes you reference often within the retention window, or open them directly from the backup folder.

**iCloud vaults**: if your vault syncs via iCloud, add `markdown.sync_provider=icloud`. Files iCloud hasn't downloaded to this device yet (a "placeholder") are downloaded before being moved; if a download is slow or fails, that one file is skipped for this run and retried the next day (the rest of the relocation still proceeds). Leave this unset (default `local`) for vaults synced by anything else (Obsidian Sync, Syncthing, Dropbox, a plain local folder, or no sync at all) — no download-wait applies there.

**Internal cleanup (opt-in, off by default)**: `markdown.out_retention_days=<days>` additionally deletes old internal bookkeeping files (not vault notes — an invisible state folder ADDE uses to avoid re-sending messages) once they're this many days past completion. It must be at least `retention_days + 1`, or the lane refuses to start with an explanation. Leave it unset if you're unsure; nothing else behaves differently either way.

**Not supported**: multiple lanes sharing the exact same `markdown.root` (relocation runs independently per lane and isn't coordinated across lanes pointed at the same vault) — use the [multiple notes/projects](#mapping-multiple-notesprojects) pattern (a separate `root`/`inbox` per lane) instead.

## Sync conflicts and caveats

- **Conflict-file isolation**: `*.sync-conflict*` / `(conflicted copy)` files — created by whatever sync tool you use (Obsidian Sync, Syncthing, Dropbox, …) — are isolated by ADDE into a `.conflicts/` folder and **never executed**.
- **Self-write safety**: even when ADDE updates the inbox/approval notes (status markers), no re-send loop occurs (idempotent via markers).
- **Watch concurrent edits**: if you edit the same line at the exact moment ADDE updates a note, a sync conflict can occur. An active session viewed on one device is recommended.

## Syncing vaults and exposure of sensitive data

If the vault is hooked to a sync service (Obsidian Sync, iCloud, Syncthing, Dropbox, etc.), the notes ADDE writes to the vault are replicated as-is to the cloud/other devices. Know what goes into the notes and place your lanes accordingly.

**What goes out to the vault** (subject to sync):

| Note                                    | Contents                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Approval note (`approvals/<req>.md`)    | Tool name and call details — the command string to run, file paths, part of the edit content |
| Output note (`out/<send-time> <id>.md`) | Full AI response and original-question excerpt — code snippets, file paths, analysis         |
| Notice note (`_adde-notice.md`)         | Operational warnings (permission-setting drift, autopass banner, etc.)                       |

**What does not go out to the vault**: the transcript, engine logs, queue, and session state are stored only in the local state folder (`~/.config/adde/<proj>/`). Secret values such as the bot token are masked (`****`) before being written to notes — but masking is based on known secret patterns, so for a **project where the code, paths, or commands themselves are sensitive**, the note contents alone can be an exposure.

**Recommended placement**:

- Put a sensitive project lane's note paths (`root`, or `inbox`/`approvals`/`outbox`) in a **folder excluded from sync** (e.g. an Obsidian Sync selective-sync-excluded folder, an iCloud-excluded directory) or a **separate local vault**.
- Don't put a personal project lane in a team-shared vault — the approval/output notes are visible to the whole team.
- To reduce the exposure surface, running just that lane on the telegram source is also an option (no note files created).

## Troubleshooting

For diagnosis and remedies by symptom, see [troubleshooting](troubleshooting.md#markdown-only) (includes a markdown-only table). If permissions are always denied, check that you checked exactly one of allow/deny before the 10-minute timeout.
