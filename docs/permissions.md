_English | [한국어](permissions.ko.md)_

# Permissions (the gate)

ADDE **routes every permission request** from the AI engine (file write, shell execution, etc.) **to channel approval**. This document explains why, how to choose a tier, and what to watch out for. Settings are **project-level** (shared by every session in the project) — full flag reference: [command reference — project add options](commands.md#project-add-options).

## Table of Contents

- [Why a gate](#why-a-gate)
- [Permission tiers](#permission-tiers)
- [allowlist / denylist](#allowlist--denylist)
- [hard-deny (outright refusal)](#hard-deny-outright-refusal)
- [Matching rules and limits](#matching-rules-and-limits)
- [Permission-drift warning](#permission-drift-warning)
- [Recommended baseline](#recommended-baseline)

## Why a gate

The engine runs headless (an ACP subprocess), so there is no one at a terminal to answer prompts. ADDE takes those approval requests and **sends them to a channel** (a markdown approval note today; Telegram/Discord inline approval is not implemented yet) so a person can allow/deny remotely.

- **fail-closed**: no response within the timeout (`gate_timeout_sec`, default 600s / 10 minutes) auto-**denies**. Channel-delivery failure or any error is also treated as deny.
- Every decision (allow, deny, auto-allow) is recorded in the conversation event record, so it's auditable from the turn note that triggered it.

## Permission tiers

Chosen at project creation or edited later — shared by every session in the project (per-session tiers are not supported; create a separate project if you need a different policy):

```bash
adde project add myproj --vault ~/Notes --perm-tier autopass --denylist "Bash,Write(/etc/*)"
adde project set myproj perm_tier acp
```

| Tier                | What is auto-allowed              | What comes to the channel         | Risk                                                                                         |
| ------------------- | --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `acp` **(default)** | only tools in `allowlist`         | **every** other tool request      | Low — a human confirms everything by default                                                 |
| `autopass` (opt-in) | everything **outside** `denylist` | only tools/patterns in `denylist` | High — most calls, including file writes and `Bash`, run without confirmation (all recorded) |

Choosing `autopass` without an explicit `--denylist` seeds the built-in default denylist (see below) and prints a one-time notice at creation.

## allowlist / denylist

- **allowlist** (`--allowlist Read,Grep`, or `adde project set <proj> allowlist Read,Grep`): tools not asked each time under `acp`. The gate stays on; auto-allow entries are still recorded. Don't add broad tools like `Bash` or file writes (self-approval risk).
- **denylist** (`--denylist "Bash,Write,Bash(git push*)"`): tools/patterns removed from auto-allow under `autopass` and returned to channel approval. Omitting `--denylist` under `autopass` records the built-in default list, which blocks destructive commands and credential reads:

  `Bash(sudo *)` · `Bash(doas *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`

Edit either list incrementally without retyping it whole: `adde project set <proj> --add-allow Read,Grep`, `--rm-deny "Bash(git push*)"` (see [command reference](commands.md#project-set--edit-settings)).

## hard-deny (outright refusal)

**hard-deny** (`--hard-deny "Bash(sudo *),Bash(rm -rf /*)"`, key `hard_deny`) is a defense-in-depth outright-refusal list using the same `Tool`/`Tool(glob)` format as `denylist`, but with different strength:

- **denylist ("return to ask")**: under `autopass`, removes from auto-allow and **falls back to channel approval** — it still runs if a human approves.
- **hard-deny ("refuse outright")**: **refuses immediately, regardless of `perm_tier` (including the default `acp`), with no channel prompt at all**. Because it applies even under `acp`, it prevents a catastrophic command from ever being accidentally approved.

`--safe-defaults` at `project add` fills hard-deny with the same built-in danger list as the default denylist above (union with any explicit `--hard-deny`). Hard-deny hits are recorded in the event record and surfaced to the channel.

## Matching rules and limits

- The match key is the **raw tool name** the engine reports (e.g. `Bash`, `Write`), case-insensitive. A request whose tool name can't be determined is not auto-allowed — it goes to channel approval (fail-closed).
- **Patterns** `Tool(glob)` match the representative argument — Bash = command string, Read/Write/Edit = file path, WebFetch = URL. `*` matches any string (including path separators) against the whole value.
- **Shell chaining**: for Bash, each chained/grouped sub-command (split on `;` `&&` `||` `|` `&`, grouping, `$(…)`, backticks, leading `VAR=` stripped) is matched too, so a prefix pattern (`sudo *`) catches `echo x && sudo y`. This is best-effort, not a full shell parser — it doesn't resolve aliases/`eval`/variable expansion, and a wrapper invocation (`bash -c "sudo y"`) is not caught. For a hard guarantee, deny the whole tool (`Bash`).
- **The gate only sees what the engine escalates via ACP `requestPermission`.** If the underlying engine auto-approves a tool per its own settings before ever asking ADDE, ADDE's gate (including `hard_deny`) is never consulted — adjust the engine's own permission configuration directly in that case.

## Permission-drift warning

If the engine's effective permissions are found looser than ADDE's policy (e.g. the engine bypasses its own permission checks), ADDE warns on the console, channel, and event record, and startup continues — but the gate can be neutralized in this state. In particular, an `autopass` project where the engine bypasses gets no permission requests at all, so the denylist has no effect.

## Recommended baseline

- Keep the default `acp` tier and put only frequently used **safe read-type tools in `allowlist`** (e.g. `Read,Grep`).
- If you need most calls auto-allowed, **opt in** to `autopass`, but keep confirmation on hard-to-undo tools (`Bash`, file writes, credential reads) via `denylist`.
- Lock catastrophic commands to refuse outright regardless of tier with `hard_deny`/`--safe-defaults` — removes any room for accidental approval.
- Tighten with `denylist`/`allowlist`/`hard_deny`, not by trying to bypass the gate through a prompt-response mode.
