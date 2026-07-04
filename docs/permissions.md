_English | [한국어](permissions.ko.md)_

# Permissions (the gate)

ADDE **routes every permission request** from the AI engine (file write, shell execution, etc.) **to channel approval**. This document explains why, how to choose a tier, and what to watch out for. The full reference for options and flags is the [command reference — lane add options](commands.md#lane-add-options).

## Table of Contents

- [Why a gate](#why-a-gate)
- [Permission tiers](#permission-tiers)
- [allowlist / denylist](#allowlist--denylist)
- [hard-deny (outright refusal)](#hard-deny-outright-refusal)
- [Matching rules and limits](#matching-rules-and-limits)
- [Permission-drift warning](#permission-drift-warning)
- [Recommended baseline](#recommended-baseline)

## Why a gate

The engine runs headless (an ACP subprocess), so there is no one at a terminal to answer prompts. ADDE takes those approval requests and **sends them to a channel (Telegram inline buttons / markdown approval notes)** so a person can allow/deny remotely.

- **fail-closed**: if you don't respond in time (default 10 minutes), it auto-**denies**. Channel-delivery failure or error is also treated as deny — "when in doubt, block."
- Every decision (allow, deny, auto-allow) is recorded in the transcript.

## Permission tiers

Choose per lane with `perm_tier` (`adde lane add --perm-tier <acp|autopass>` or conf `perm_tier=`).

| Tier                | What is auto-allowed              | What comes to the channel         | Risk                                                                                   |
| ------------------- | --------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `acp` **(default)** | only tools in `allowlist`         | **every** other tool request      | Low — by default a human confirms everything                                           |
| `autopass` (opt-in) | everything **outside** `denylist` | only tools/patterns in `denylist` | High — most, including file writes and `Bash`, run without confirmation (all recorded) |

- An `autopass` lane sends a **warning banner** to the channel at startup (auto-allow mode and denylist composition).
- The behavior of the default (`acp`) never changes under any circumstance.

## allowlist / denylist

- **allowlist** (`--allowlist Read,Grep`): tools not to be asked each time under the `acp` tier. The gate itself stays on and auto-allow entries are recorded. Don't add broad tools like `Bash` or file writes (self-approval risk).
- **denylist** (`--denylist "Bash,Write,Bash(git push*)"`): tools/patterns to remove from auto-allow under the `autopass` tier and return to channel approval. Omitting `--denylist` records a built-in default list into the conf that blocks destructive commands and credential reads.

## hard-deny (outright refusal)

**hard-deny** (`--hard-deny "Bash(sudo *),Bash(rm -rf /*)"`, conf key `hard_deny=`) is a defense-in-depth outright-refusal list. It uses the same `Tool` / `Tool(glob)` format as `--denylist`, but its strength differs.

- **denylist ("return to ask")**: under `autopass`, removes from auto-allow and **falls back to channel approval** — it runs if a human approves.
- **hard-deny ("refuse outright")**: **refuses (cancels) a matching request immediately, regardless of `perm_tier`, with no channel prompt at all**. Because it applies even to the default `acp` tier, it **prevents a catastrophic command from being accidentally approved** in the first place. Hard-deny hits are recorded in the transcript and a notice is sent to the channel.

Enabling `--safe-defaults` (reflected in the conf key; the interactive `lane add`/`adde init` asks whether to enable it, default yes) fills hard-deny with the built-in danger list (union with any explicit `--hard-deny`):

`Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`.

A list is just a list, not complete defense (see shell chaining below) — tune it to your project.

## Matching rules and limits

- The match key is the **raw tool name** the engine reports (e.g. `Bash`, `Write`), case-insensitive. A request whose tool name cannot be determined is not auto-allowed and is sent to channel approval (fail-closed).
- **Patterns** `Tool(glob)` match the representative argument — Bash = command string, Read/Write/Edit = file path, WebFetch = URL. `*` is any string (including path separators), matched against the whole (prefix block `Bash(git push*)`, contains block `Bash(*sudo *)`).
- **Shell chaining**: for Bash commands, each chained/grouped sub-command (split on `;` `&&` `||` `|` `&`, grouping `(` `)` `{` `}`, `$(…)`, backticks, and newline, with leading `VAR=` assignments stripped) is matched too, so a prefix pattern (`sudo *`) catches `echo x && sudo y`, `(sudo y)`, and `FOO=1 sudo y`. Matching is best-effort, not a full shell parser: it does not resolve aliases, `eval`, variable expansion, or wrapper invocations (`bash -c "sudo y"` is **not** caught), and it splits on operator characters even inside quotes — so under `--safe-defaults` a benign command whose quoted argument contains an operator plus a danger token (e.g. `git commit -m "fix && sudo cleanup"`) may be refused with no override. For a certain block, specify the whole tool (`Bash`).

## Permission-drift warning

If the engine's effective permissions are found looser than ADDE's policy (e.g. the engine has `bypassPermissions`), it warns on the console, channel, and transcript, and startup continues. In this state the gate can be neutralized, so disable the engine's permission setting or align it with the conf `perm_tier`. In particular, **an `autopass` lane where the engine bypasses gets no permission requests at all, so the denylist doesn't work.**

## Recommended baseline

- Keep the default `acp` tier and put only frequently used **safe read-type tools in `--allowlist`** (e.g. `Read,Grep`).
- If you must auto-allow most things, **opt in** to `autopass`, but always keep confirmation on hard-to-undo tools (`Bash`, file writes, credential reads) via the `denylist`.
- Lock catastrophic commands to be refused outright regardless of tier with `--hard-deny` (or `--safe-defaults`) — this removes any room for accidental approval.
- Don't try to bypass the gate via a prompt-response mode; instead **tighten with the denylist, allowlist, and hard-deny**.
