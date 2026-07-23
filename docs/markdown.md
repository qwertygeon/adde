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

# optional: with the inbox zoned layout on (default — see below), a sent message's body is always
# moved here at send time as a dated file (YYYY-MM-DD.md), leaving only the compact `✅ sent [[...]]`
# marker in the inbox (keeps a long-running inbox small). This key only overrides *where* that
# happens — set it to point the archive somewhere else; leave it unset and archiving still happens,
# just to the default `sent-archive/` directory next to the inbox.
# Note: before v0.1.5, this was a single file. An existing single archive file from an older
# version is auto-migrated (moved into the backup folder below, or kept alongside as `<name>.legacy`
# if no backup folder is set) the first time the lane starts after upgrading.
markdown.archive=adde/my-lane/sent-archive/

# optional (default on): the inbox zoned layout bundle — a resident marker palette, a compose
# boundary, a records (history) zone, and send-time auto-archiving (described in detail below).
# Set to "off" to restore the simpler pre-this-version behavior (no palette/compose marker/records
# zone; archiving only happens when markdown.archive above is explicitly set).
# markdown.layout=on

# optional (default on, only relevant when markdown.layout is on): show the resident marker palette
# at the top of the inbox. Set to "off" to hide just the palette — the compose boundary, records
# zone, and auto-archiving keep working; session-control checkboxes (clear/compact/resume/archive)
# still work wherever you place them in the note.
# markdown.palette=on

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
- These keys can also be edited in place without hand-editing the file: `adde lane set <proj> <lane> markdown.<key> <value>` (e.g. `adde lane set myproj md-claude markdown.retention_days 5`) — see the [command reference](commands.md#lane-set--edit-an-existing-lane-conf-in-place).

## 2. Start the lane

```bash
adde up <proj>     # start all lanes in lanes.d
adde down <proj>   # stop the lanes
```

Once started, ADDE begins watching the inbox/approvals notes and the output directory. Check status with `adde status <proj>` and the config with `adde doctor <proj>` — for the full command set see the [command reference](commands.md).

## 3. Sending instructions (inbox)

With the inbox zoned layout on (the default — see `markdown.layout` in the config above), ADDE organizes the input note (`inbox.md`) into three zones: a resident **marker palette** + your writing area at the top, then a `<!-- adde:compose -->` boundary marking where your message starts, and a **records zone** at the bottom holding a compact, newest-first history:

```markdown
- [ ] 🗄️ archive
- [ ] 🧹 clear
- [ ] 🗜️ compact
- [ ] ♻️ resume
<!-- adde:compose -->
- [ ] 📤 send
## Sent history
<!-- adde:records -->
```

1. Write the message (prompt) on the blank line(s) between `<!-- adde:compose -->` and the `- [ ] 📤 send` checkbox. Multiple lines are fine. Text above `<!-- adde:compose -->` (the palette area) is never treated as message content.
2. When ready to send, tap/check the checkbox: `- [x] 📤 send`.
3. ADDE detects it and delivers the message to the AI. That line changes in two stages:
   ```markdown
   - [x] ⏳ sending a1b2c3d4 20260703-162045 ← send started (durable record — stays right here until done)
   - [x] ✅ sent [[20260703-162045 a1b2c3d4]] ← moved into the records zone once the send completes
   ```
   Once it completes, the message body is moved into the archive (see below) and a compact `✅ sent [[send-time id]]` marker is placed at the top of the records zone (newest first). `[[send-time id]]` is a wikilink identical to the response note's filename, so once the response is created you can click the link to jump straight to it (in Obsidian or other wikilink-supporting editors). Even if ADDE dies mid-way and stalls at `⏳ sending`, it stays exactly where it is (the send box) — on restart it re-sends only the missing part exactly once and finishes with `✅ sent` (no duplicates/losses).

After a send, ADDE restores a fresh empty `- [ ] 📤 send` right after the compose marker, so the writing area is always ready and never buried under accumulated history (no scrolling to the bottom of a long note).

> **The prompt is the text between the compose marker and the send box, never above it or below it.** If `<!-- adde:compose -->` is missing (a legacy note, or `markdown.layout=off`), ADDE falls back to reading the prompt from the text directly above the send box, same as before this version. (If you check the box with nothing to send, it produces `⚠️ empty` in the records zone.)

> **The trigger is only a checkbox whose label is exactly `send`** (a leading emoji is allowed — `- [x] 📤 send`). A checkbox with other words mixed in, like `- [x] please send the mail`, is not a trigger but treated as ordinary message body, so you can freely use to-do checkboxes inside a message.

### The marker palette (session control)

Four control markers sit permanently at the top of the note, always unchecked and ready — set `markdown.palette=off` to hide this block (the rest of the layout keeps working):

```markdown
- [ ] 🗄️ archive ← on check, clean up the records zone (see below)
- [ ] 🧹 clear    ← on check, start a new session (clears prior conversation context)
- [ ] 🗜️ compact  ← on check, compact the context
- [ ] ♻️ resume   ← on check, list recent sessions (number, excerpt, last conversation time) into a response note
```

Check any marker to run that action once — ADDE runs it and **restores the same marker back to unchecked** right where it is; the palette never disappears or gets consumed. `resume 2` (with a session number, typed anywhere in the note) also works to jump straight to session #2, and is restored the same way. This is a repositioning of the pre-existing session-control checkboxes (`clear`/`compact`/`resume`) into one resident block, not a new command surface — `archive` is the one addition (previously a separate ad hoc checkbox, now part of the palette). Details: [command reference](commands.md#session-control-channel-commands).

### The records zone (history) and archiving

The bottom of the note carries a human-readable heading and an `<!-- adde:records -->` anchor; everything below it is your compact history, newest entry first:

```markdown
## Sent history
<!-- adde:records -->
- [x] ✅ sent [[20260703-163000 b2c3d4e5]]
- [x] ✅ sent [[20260703-162045 a1b2c3d4]]
```

You're free to delete any line in the records zone yourself, any time — **the one exception is `⏳ sending`**, which must never be removed while a send is in flight (deleting it would make ADDE unable to tell whether that message was ever delivered; once it becomes `✅ sent` it's just a compact marker and safe to delete manually).

With the layout on, the message body is moved into the archive **the moment it's sent** — the inbox only ever holds the compact `✅ sent [[...]]` marker afterward. This happens automatically whether or not `markdown.archive` is set (see config above; that key only overrides *where*). If the archive write itself fails (disk full, permission denied, …), the body stays in the inbox instead of being lost — nothing is ever dropped, and the send itself still completes normally.

- **Tidying the records zone**: check the `- [x] 🗄️ archive` palette marker to delete all completed `✅ sent [[...]]`/`⚠️ empty` lines from the records zone in one go, replaced by a single `- [x] 🗄️ archived N <time> · auto` summary line (bodies were already archived at send time, so this only cleans up the records zone — it doesn't move anything). It only touches completed segments; a message you're still drafting is never touched.
- **Legacy lines are your own responsibility**: older-format `sent <id>` lines (no wikilink, from before this version) and any pre-existing `archived N` summary line are left untouched by the `archive` marker — remove them yourself if you don't want them around.

The archive is a directory of plain append-only dated files (`<archive-dir>/YYYY-MM-DD.md`, each entry a `## [[send-time id]]` heading + the body). Your delivered messages and responses are unaffected — archiving only rewrites the inbox surface, never the queue or the response notes, so it can never lose or re-send a message.

### Legacy notes and turning the layout off

- **Legacy inbox notes** (no palette/compose marker/records anchor yet) keep working without any manual migration: ADDE reads the prompt with the old "text above the send box" rule, and self-heals the structure (adds the palette/compose marker/records zone) the next time it processes the note — without losing your draft or any existing history.
- **`markdown.layout=off`** restores the pre-this-version behavior exactly: no palette, no compose marker, no records zone — a sent message terminates in place with `✅ sent [[...]]`, and auto-archiving only happens when `markdown.archive` is explicitly set (checking `- [x] 🗄️ archive` still works, moving completed message bodies into the archive file). Use this if you prefer the older, simpler surface.

## 4. Receiving responses (output notes)

An AI response is created in the output directory (`adde/<lane>/out/`) as **one note per message** (`<send-time> <id>.md`, e.g. `20260703-162045 a1b2c3d4.md`). Since the filename begins with the send time, they sort chronologically, and because the name matches the inbox's `✅ sent [[...]]` wikilink, the link opens it directly. The top of the note carries a question excerpt and time metadata:

```markdown
> ❓ analyze the cause of the build error
> 🕒 sent 20260703-162045 · done 20260703-162130

(AI response body)
```

Open and read the note in your editor. If message processing itself fails, instead of a response note, the notice note (`_adde-notice.md`) records the failure and remediation guidance (the message is preserved and reprocessed on restart).

## 5. Permission approval (approval notes)

When the AI calls a tool that needs permission — file write, Bash execution, etc. — a note dedicated to that request (`<req-id>.md`) is created in the approvals directory (`approvals/`) (one request = one file — minimizes concurrent-edit conflicts):

```markdown
### ⏳ req 7f3a · Bash

> rm -rf build/ (cwd: /Users/me/work/my-project)
> 🕒 requested 20260703-162045 · auto-deny at 20260703-163045 if no response
> check exactly one box below — allow or deny (leaving both keeps it pending)

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
