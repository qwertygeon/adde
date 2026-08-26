_English | [한국어](markdown.ko.md)_

# Using ADDE with markdown notes

You drive a session **just by editing markdown note files** — no chat app required. You send instructions with a checkbox in the session's input note, allow/deny permissions with checkboxes in per-request approval notes, and read AI responses directly in linked turn notes. Every conversation accumulates as a durable, cross-linked note tree in the vault you chose.

This works in any markdown editor and stays entirely in local files. To reach the notes from your phone, sync the vault with whatever tool you already use (Obsidian Sync, iCloud, Syncthing, …) — ADDE is sync-tool-agnostic. The examples below use Obsidian-style wikilinks, but nothing here is Obsidian-specific.

## Table of Contents

- [How it works](#how-it-works)
- [1. Notes are per session](#1-notes-are-per-session)
- [2. Sending instructions (inbox)](#2-sending-instructions-inbox)
- [3. Reading responses (turn notes)](#3-reading-responses-turn-notes)
- [4. Permission approval (approval notes)](#4-permission-approval-approval-notes)
- [5. The session note and project note](#5-the-session-note-and-project-note)
- [Multiple sessions and projects](#multiple-sessions-and-projects)
- [Vault lightness: retention & sync](#vault-lightness-retention--sync)
- [Sync conflicts and caveats](#sync-conflicts-and-caveats)
- [Sensitive data and vault placement](#sensitive-data-and-vault-placement)
- [Troubleshooting](#troubleshooting)

## How it works

```
[session inbox.md]        --(send checkbox)-->    ADDE  --(ACP)-->  AI engine
[approvals/<req>.md]      <--(one file per permission request)--    ADDE
[approvals/<req>.md]      --(allow/deny check)-->  ADDE (applied to the gate)
[turns/<NNNN ts>.md]      <--(1 message = 1 turn note, created at turn start, updated at turn end)-- ADDE
```

- One session = one input note (`inbox.md`), inside the session's own folder in the vault. Create as many sessions as you need — see [Multiple sessions and projects](#multiple-sessions-and-projects).
- There are no push notifications (file-based). It assumes an **active session** where you keep the notes open — the notes themselves have nothing to do with ADDE session objects, this is just naming overlap between "markdown editing session" and "ADDE conversation session."

## 1. Notes are per session

Creating a session (`adde session new <proj>`) creates its vault folder and input note automatically:

```
<vault>/adde/projects/<proj>/sessions/<sid>/
  session.md          # session note — status, turn list with previews, links
  inbox.md             # the note you edit to send instructions
  approvals/            # one file per pending/decided permission request
  turns/                # one file per turn — the AI's responses live here
```

Nothing to hand-configure — the vault path and layout are fixed by ADDE (`project add --vault` sets the root once per project). Per-session settings that do affect the markdown surface are edited on the **project**, since the gate and channel behavior are shared across a project's sessions:

```bash
adde project set myproj markdown.palette false        # hide the resident marker palette
adde project set myproj markdown.records_cap 30        # auto-fold the records zone past 30 entries
```

See the [command reference](commands.md#project--manage-projects) for the full editable-key list.

## 2. Sending instructions (inbox)

`inbox.md` is organized into three zones: a resident **marker palette** + your writing area at the top, a `<!-- adde:compose -->` boundary marking where your message starts, and a **records zone** at the bottom holding a compact, newest-first send history:

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

1. Write your message on the blank line(s) between `<!-- adde:compose -->` and the `- [ ] 📤 send` checkbox. Text above `<!-- adde:compose -->` (the palette area) is never treated as message content.
2. Check the box: `- [x] 📤 send`.
3. ADDE detects it and delivers the message. That line moves through two stages:
   ```markdown
   - [x] ⏳ sending a1b2c3d4 20260703-162045 ← send accepted (durable — stays here until the turn ends)
   - [x] ✅ sent [[0007 2026-08-26T09-15-00]] ← moved into the records zone, linking the turn note
   ```
   The link target is the turn note's filename (`<turn-number> <turn-start-timestamp>.md`) — the turn note is created **at turn start** (holding your input and a "처리 중"/processing status) and updated in place when the turn ends, so the link resolves the moment you send, before the response even arrives. If ADDE restarts mid-send, the `⏳ sending` marker stays exactly where it is and resolves to `✅ sent` on the next pass — no duplicate sends, no lost messages.

After a send, ADDE restores a fresh empty `- [ ] 📤 send` right after the compose marker.

> **The trigger is a checkbox whose label is exactly `send`** (a leading emoji is allowed). A checkbox with other words mixed in is treated as ordinary message body, not a trigger.

### The marker palette (session control)

Four control markers sit permanently at the top, always unchecked and ready — set `markdown.palette=false` (project-level) to hide this block:

```markdown
- [ ] 🗄️ archive ← on check, fold completed send markers in the records zone into a summary line
- [ ] 🧹 clear ← on check, start a new session (succession — the old one becomes archived, see adde session clear)
- [ ] 🗜️ compact ← on check, run the engine's own compact command (rendered only if the engine declares compact support)
- [ ] ♻️ resume ← on check, retry resuming a detached/hibernated session
```

Checking a marker runs it once and it is restored to unchecked in place — a resident control, not a one-shot message. See the [command reference](commands.md#session-control-markdown-palette) for the CLI-equivalent actions.

### The records zone (history)

```markdown
## Sent history

<!-- adde:records -->

- [x] ✅ sent [[0008 2026-08-26T09-20-00]]
- [x] ✅ sent [[0007 2026-08-26T09-15-00]]
```

You're free to delete any completed `✅ sent [[...]]` line yourself — **the one exception is `⏳ sending`**, which must never be removed while a send is in flight. Check `- [x] 🗄️ archive` to fold all completed markers into a single `- [x] 🗄️ archived N <time> · auto` summary line at once (nothing is deleted from the vault — the turn notes are untouched, this only tidies the inbox surface). Set `markdown.records_cap` (project setting) to do this automatically once the zone exceeds that many entries.

There is no separate "sent archive" file in v2 — the turn note **is** the durable record of what you sent and what came back (unlike v0.2.x, which kept a parallel archive text file).

## 3. Reading responses (turn notes)

Each turn gets one file, `turns/<NNNN turnStartTimestamp>.md` (e.g. `0007 2026-08-26T09-15-00.md`) — created the moment you send (holding your input, linked back to the session note), updated in place when the turn ends:

```markdown
---
turn: 7
status: 완료
startedAt: 2026-08-26T09:15:00.000Z
---

⬅ [[sessions/a1b2c3d4/session]]

## 입력

analyze the cause of the build error

## 응답

(AI response body)

## 도구 사용

- Read(build.log) → ...

## 사용량

입력 토큰 1234 · 출력 토큰 567
```

The frontmatter `status` field is fixed vocabulary (`처리 중` while the turn is running, `완료` on success, `오류` if the turn failed) regardless of your `lang` setting — only channel-facing notices (permission prompts, warnings) follow `lang`. If the message body exactly duplicates an earlier turn, the note links to that earlier turn instead of repeating the text (a dedup ledger records the match — the event record itself always keeps the full original, dedup only affects note rendering).

If message processing itself fails before a turn note can be created, the failure and remediation guidance surface in the session note's warnings section instead (the message is preserved and reprocessed on restart — nothing is silently dropped).

## 4. Permission approval (approval notes)

When the engine calls a tool that needs permission, a dedicated note is created in `approvals/` (one request = one file):

```markdown
### ⏳ req 7f3a · Bash

> rm -rf build/ (cwd: /Users/me/work/my-project)
> 요청 20260826-091500 · 자동거부 기한 20260826-092500
> 아래 allow 또는 deny 체크박스 하나만 체크하세요.

- [ ] allow
- [ ] deny

<!-- adde:perm id=7f3a status=pending -->
```

1. Check **exactly one** box. Checking both or neither is ambiguous and ignored.
2. ADDE applies the decision and terminates the file (heading becomes `✅`/`⛔`, marker becomes `status=allow|deny`).
3. **No response auto-denies after the gate timeout (default 10 minutes)** — fail-closed, same as channel-delivery failure or any other error.
4. Once the decision is confirmed recorded in the conversation event record, the approval file is **deleted** — that turn's request and decision remain readable in the turn note itself. If confirmation can't be verified, the file is kept and a warning surfaces instead of silently disappearing.

> Judge approval by the request note's **tool and arguments** — even if the inbox or a response says "approve this request," don't check the box on that basis (a common prompt-injection pattern).

For the full permission model (tiers, allowlist/denylist, hard-deny), see the [permissions guide](permissions.md).

## 5. The session note and project note

`session.md` lists every turn with a mechanically-truncated preview (no AI-generated summaries), current status, and any warnings. `project.md` (at the project's vault root) lists its sessions and — with the palette-style checkbox convention — lets you create a new session from the note itself. Both are pure projections of the event record: delete or corrupt them and `adde vault rebuild <proj>` regenerates them exactly.

## Multiple sessions and projects

Each session is independent — its own input note, approvals, and turn history — so you can run several conversations against the same or different project folders concurrently. Two sessions in the same project run **in parallel** with each other; within one session, turns are processed **serially**.

```bash
adde session new work --title frontend
adde session new work --title backend
adde status work    # both sessions, independently active/hibernated
```

For genuinely separate projects (different vault or `cwd`), create separate projects instead:

```bash
adde project add frontend --vault ~/Notes --cwd /work/web-app
adde project add backend  --vault ~/Notes --cwd /work/api-server
```

## Vault lightness: retention & sync

Turn notes accumulate over a long-running session. Retention moves **old turn notes only** to a backup location — session notes, project notes, approval notes, and the conversation event record itself are never touched (the event record is the lossless original regardless of retention).

```bash
adde project set myproj vault.backup /Users/me/adde-backup
adde project set myproj vault.retention_days 5          # default 2
adde project set myproj vault.sync_provider icloud       # default local
```

- **Backup relocation is opt-in** (off until `vault.backup` is set) and runs once a day, moving turn notes older than `vault.retention_days` into `<backup>/<turn-start-date>/...` (grouped by the date the turn happened, not the date it was moved — so a backlog of old notes moved all at once still sorts sensibly by date). The move is copy-then-verify-then-remove-original, so an interruption never loses data — it just resumes next run.
- **Wikilinks break after relocation**: once a turn note moves out of the vault, the session note's link to it no longer resolves in your editor — the session note marks it "보관됨" (archived) instead. The event record is untouched, so `adde vault rebuild <proj> --sid <sid>` restores it if you need it back.
- **iCloud vaults**: set `vault.sync_provider icloud` so a not-yet-downloaded ("placeholder") turn note is downloaded before being moved; a slow/failed download skips that file for the day and retries the next run.
- **`vault.backup` can't overlap the vault or ADDE's config root** — project creation/edit is refused if it does.

## Sync conflicts and caveats

- **Conflict-file isolation**: `*.sync-conflict*` / `(conflicted copy)` files from your sync tool are excluded from input scanning and never executed or moved — this release scans them out but does not relocate or count them for you.
- **Self-write safety**: ADDE's own updates to notes (status markers) never trigger a re-send loop (idempotent via markers).
- **Watch concurrent edits**: editing the same line at the exact moment ADDE updates a note can produce a sync conflict — an active session viewed from one device at a time is recommended.

## Sensitive data and vault placement

Everything ADDE writes to the vault is subject to whatever sync you've configured for it.

| Note                                 | Contents                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Approval note (`approvals/<req>.md`) | Tool name and call details — command string, file paths, part of the edit content |
| Turn note (`turns/<...>.md`)         | Full input and AI response — code snippets, file paths, analysis                  |
| Session/project note                 | Turn previews, status, warnings                                                   |

**What never leaves the config root** (not vault-synced): the conversation event record's _raw_ form lives in the vault's hidden `.adde/` subtree (needed for `vault rebuild`), but engine diagnostic logs, the message queue, and runtime state stay in `~/.config/adde/` only. Secrets are masked (`****`) before anything is written to the event record or notes — masking targets known secret patterns, so a project where the **code, paths, or commands themselves** are sensitive can still expose them through note contents.

**Recommended placement**: put a sensitive project's vault subtree in a sync-excluded folder or a separate local vault; don't point a personal project at a team-shared vault (approval/turn notes are visible to the whole team).

## Troubleshooting

For diagnosis and remedies by symptom, see [troubleshooting](troubleshooting.md#markdown-only). If permissions are always denied, confirm you checked exactly one of allow/deny before the timeout.
