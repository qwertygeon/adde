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
- [status — lane status](#status--lane-status)
- [doctor — environment check](#doctor--environment-check)
- [logs — recent activity](#logs--recent-activity)
- [sessions — session list](#sessions--session-list)
- [Session control (channel commands)](#session-control-channel-commands)
- [lane — lane configuration](#lane--lane-configuration)
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

Running `adde` with no arguments, or `-h`/`--help`/`help`, prints the overall usage. For a specific command's help, `adde <command> --help` (e.g. `adde status --help`, `adde lane add --help`).

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
  ✔ ACP adapter binary: @zed-industries/claude-code-acp resolved
  ✔ config base directory: ~/.config/adde
  ✔ daemon entry: /opt/homebrew/lib/node_modules/adde/dist/cli/adde.js

install short aliases (ad, add) next to the adde command? (Y/n) [y]: y
  ✔ alias created: ad → /usr/local/bin
  ✔ alias created: add → /usr/local/bin

project name [default]: myproj
lane name [main]: tg-claude
source (telegram or markdown) [telegram]: telegram
engine [claude-code-acp]:
backend [acp]:
channel [telegram]:
perm_tier (acp or autopass) [acp]:
acp_version [v1]:
allowlist (comma-separated, empty for none): Read,Grep
enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright (y/N) [y]: y
lang (channel message locale: en/ko, empty for global):
cwd (absolute lane working directory, empty to skip): /Users/me/work/my-project
chat_id (reply target + authorizes that chat for inbound, empty to skip): 12345678
allow_from (extra authorized sender ids, comma-separated, empty to skip):
file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable) [private]:
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
- **Auto-recovery**: launchd automatically restarts the daemon after a macOS reboot/logout.
- **Double-start guard**: an already-running lane prints a warning and remedy hint and is skipped. Double starts do not happen.
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

## status — lane status

```bash
adde status [<proj>] [--all] [--json]
```

Scans each lane in `lanes.d` and determines its status.

| Status    | Meaning                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `running` | State file exists, the launched process (pid) is alive, and the heartbeat is fresh     |
| `stale`   | The pid is alive but the heartbeat (state-file mtime) has stopped — **suspected hung** |
| `dead`    | State file exists but the process is gone — **abnormal exit (crash) residue**          |
| `stopped` | No state file — normal exit or never started                                           |

- **With `<proj>`**: prints all lanes of that project (including stopped) in a `LANE · STATUS · PID · UPTIME · SEEN · SOURCE` table.
- **Without `<proj>`**: aggregates all projects (`~/.config/adde/*/`) and prints **running (non-stopped) lanes** in a `PROJECT · LANE · …` table. If no lanes are running, an informational message.
- **`--all`** (when `<proj>` is omitted): show all lanes including stopped (`stopped`).
- If there are `dead`/`stale` lanes, remedy guidance is appended (`SEEN` = time since the last heartbeat).
- Heartbeat: `adde up` periodically refreshes the state-file mtime. Even if the pid is alive, if the refresh stops past a threshold it is judged `stale` (hung).
- `--json`: an array of lane objects (for monitoring/scripts, including `lastSeenAt`; annotated with `proj` when aggregating).
- **Update notice**: if a newer version is available on npm, a one-line notice is appended (`npm i -g adde@latest` … then `adde restart`). It uses a 24-hour cache (under the config base), only hits the network in an interactive terminal (TTY), and can be disabled with the `ADDE_NO_UPDATE_CHECK` env var.
- Read-only (no side effects).

```bash
adde status myproj          # per-lane table for one project (includes stopped)
adde status --all           # every project, including stopped lanes
adde status myproj --json   # machine-readable array (monitoring/scripts)
```

## doctor — environment check

```bash
adde doctor [<proj>]
```

Performs a static check independent of status and reports each item as `PASS` / `WARN` / `FAIL`. Failures/warnings carry a remedy hint (`↳ action:`).

- Global: Node version (≥22) · ACP adapter binary resolution · config base directory · (macOS) daemon entry file resolution.
- With `<proj>`, per lane: source validity · `cwd` existence · (telegram) `.env` token presence.
- **File-permission audit** (with `<proj>`, per lane): `WARN` if `state/<lane>/.env` is group/other-accessible (expects 0600 — bot-token exposure risk), and `WARN` if `file_mode=private` but the `state/<lane>` directory is group/other-accessible (expects 0700), with a `chmod`/`adde restart` hint. `file_mode=shared` is treated as an intentional choice and not warned.
- With `<proj>`, on macOS it also checks the launchd daemon registration state — it cross-checks plist existence against launchctl registration and surfaces a mismatch (plist present but not registered with launchd, or vice versa) as `WARN`.
- **Update notice**: like `status`, if a newer version is available on npm it prints a one-line notice (24-hour cache · network only in TTY · disable with `ADDE_NO_UPDATE_CHECK`).
- Read-only. It's for self-diagnosing "why won't it start" before startup.

## logs — recent activity

```bash
adde logs <proj> <lane> [N] [--engine]
```

Prints the last `N` lines of that lane's `transcript.log` (ACP session event record) (default 50). If the file doesn't exist, prints an informational message.

- `N`: how many trailing lines to print (default 50).
- `--engine`: prints `engine.log` (the engine subprocess's captured stderr) instead of the transcript. Use it to see the engine's own diagnostic output (tracing `stale`/startup-failure causes, etc.).

```bash
adde logs myproj tg-claude 100 --engine   # last 100 lines of the engine stderr log
```

## sessions — session list

```bash
adde sessions <proj> <lane>
```

Prints the lane's engine session ledger — number, first-prompt excerpt, **last conversation time**, and session id (the current session marked with `◀`). Resuming/resetting sessions is done from the channel (see "Session control (channel commands)" below).

## Session control (channel commands)

Resetting, compacting, and resuming a conversation session is instructed **from the channel**, not the CLI (it respects the in-progress turn, is processed serially in the message queue, and the result is announced as a channel response).

| Action                      | Telegram (exact match)         | Markdown (dedicated checkbox label) | Result                                                                          |
| --------------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| Start a new session (reset) | `/clear`                       | `- [x] 🧹 clear`                    | Restart the engine as a new session — clears prior conversation context         |
| Compact context             | `/compact`                     | `- [x] compact`                     | Run the engine's compact command (conversation kept, context condensed)         |
| Session list                | `/resume`                      | `- [x] resume`                      | Respond with a recent-session list (number, excerpt, last conversation time)    |
| Resume a session            | `/resume <number\|session-id>` | `- [x] resume <number\|session-id>` | Return to that session (falls back to a new session with a notice if not found) |

- Telegram interprets it as control only when the whole message **exactly matches** a command — a `/clear` inside a sentence is passed through as an ordinary prompt. In group chats the bot-mention suffix (`/clear@botname`, `/compact@botname`, `/resume@botname <number>`) is allowed.
- Markdown labels use the same contract as send: exact label match (leading emoji allowed), runs on check, and after processing the line terminates as `✅ sent [[...]]` with the result note linked.
- A lane restart (`adde restart`) also starts a new session (no auto-resume — to continue, restart then pick with `/resume`).

## lane — lane configuration

Creates, lists, and deletes a lane conf (`lanes.d/<lane>.conf`). One file = one lane.

```bash
adde lane add <proj> <lane> [options]   # create
adde lane ls <proj>                      # list
adde lane show <proj> <lane>             # print conf
adde lane rm <proj> <lane>               # delete (side data like state/queue is preserved)
adde lane help                           # all options
```

`ls`/`rm` can also be written as `list`/`remove` (same behavior).

### lane add options

| Option                                               | Default                                                         | Description                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <telegram\|markdown>`                      | `telegram`                                                      | Channel source                                                                                                                                                  |
| `--engine <name>`                                    | `claude-code-acp`                                               | ACP engine profile                                                                                                                                              |
| `--backend <name>`                                   | `acp`                                                           | Backend                                                                                                                                                         |
| `--channel <name>`                                   | source value                                                    | Gate routing                                                                                                                                                    |
| `--perm-tier <acp\|autopass>`                        | `acp`                                                           | Permission tier. `acp`=channel-approve every tool / `autopass`=auto-allow outside the denylist (opt-in)                                                         |
| `--acp-version <v>`                                  | `v1`                                                            | ACP version                                                                                                                                                     |
| `--cwd <abs-path>`                                   | (supervisor cwd)                                                | This lane's AI working folder (project mapping)                                                                                                                 |
| `--allowlist <a,b,c>`                                | (none)                                                          | Auto-allowed tools (gate stays on; for `perm_tier=acp`)                                                                                                         |
| `--denylist <entries,...>`                           | built-in default list under autopass (see **default denylist**) | Tools/patterns to fall back to channel approval under `autopass` — `Bash` (whole tool) or `"Bash(git push*)"` (representative-argument glob)                    |
| `--hard-deny <entries,...>`                          | (none)                                                          | Tools/patterns to **refuse outright** regardless of tier (no channel prompt at all, conf key `hard_deny=`) — same format as `--denylist`                        |
| `--safe-defaults`                                    | —                                                               | Fill hard-deny with the built-in danger list (union with any explicit `--hard-deny`). The interactive `lane add`/`init` asks whether to enable it (default yes) |
| `--lang <en\|ko>`                                    | (global locale)                                                 | Language of this lane's **channel messages** (permission prompts, warning banner, notice notes)                                                                 |
| `--chat-id <id>`                                     | (none)                                                          | telegram reply target. A **private chat** (positive) auto-allows inbound (group = negative is reply-only; members via `allow_from`)                             |
| `--allow-from <ids>`                                 | (none)                                                          | telegram inbound-allowed sender user ids (comma-separated). Combined with the private `chat_id` for authentication (required to authenticate group members)     |
| `--file-mode <private\|shared>`                      | `private`                                                       | Permissions of the state/out/queue directories. `private`=0700 (owner only) / `shared`=not locked (umask default, typically readable by other users)            |
| `--token-stdin`                                      | —                                                               | Read the telegram bot token from stdin and write it to `.env` (0600)                                                                                            |
| `--root <abs-path>`                                  | (none)                                                          | markdown root (e.g. Obsidian vault)                                                                                                                             |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | —                                                               | markdown note paths (relative to root)                                                                                                                          |
| `--force`                                            | —                                                               | Overwrite an existing conf                                                                                                                                      |
| `--interactive`                                      | —                                                               | Force the interactive wizard (TTY only — errors on a non-TTY)                                                                                                   |
| `--no-interactive`                                   | —                                                               | Force non-interactive (use flags/defaults, no prompts) — for scripts/CI                                                                                         |

**Interactive by default**: on a TTY, `adde lane add <proj> <lane>` with **no field flags** launches the interactive wizard automatically — no `--interactive` needed. It becomes non-interactive when any field flag is given (`--source`, `--engine`, `--backend`, `--channel`, `--perm-tier`, `--acp-version`, `--cwd`, `--allowlist`, `--denylist`, `--hard-deny`, `--safe-defaults`, `--lang`, `--chat-id`, `--allow-from`, `--file-mode`, `--root`, `--inbox`, `--approvals`, `--outbox`, `--token-stdin`), when `--no-interactive` is passed, or when stdin is not a TTY (scripts/CI). `--interactive` force-enables it (and errors on a non-TTY); `--no-interactive` force-disables it. `<proj>` and `<lane>` are always required positional arguments.

In the wizard, the telegram bot token is prompted **last, with hidden input** (keystrokes not echoed) and written to `.env` (0600); leave it empty to defer it (set it later via `--token-stdin` or by editing `.env`). The wizard also asks whether to enable `--safe-defaults` (the hard-deny danger list, default yes). Enum/numeric fields are validated at entry and re-prompt on bad input — `perm_tier` (acp|autopass), `file_mode` (private|shared), `lang` (en|ko or empty), `chat_id` (numeric or empty), `allow_from` (comma-separated numeric or empty), and `source` (telegram|markdown). At creation, a missing `cwd`, a missing markdown `root`, or a malformed telegram token is reported as a **warning** but creation still proceeds.

**Example: interactive** (auto-launched on a TTY — the field prompts follow the required `<proj> <lane>`):

```text
$ adde lane add myproj tg-claude
source (telegram or markdown) [telegram]: telegram
engine [claude-code-acp]:
backend [acp]:
channel [telegram]:
perm_tier (acp or autopass) [acp]: autopass
acp_version [v1]:
allowlist (comma-separated, empty for none): Read,Grep
denylist (tools/patterns that fall back to channel approval, comma-separated) [Bash(sudo *),Bash(rm -rf /*),Bash(rm -rf ~*),Bash(rm -rf .*),Bash(git push --force*),Bash(git push -f*),Bash(git reset --hard*),Bash(git clean -fd*),Read(~/.ssh/**),Read(~/.aws/**),Read(~/.npmrc),Read(~/.config/gh/hosts.yml),Read(~/.kube/config),Read(~/.docker/config.json),Read(~/.config/gcloud/**)]:
enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright (y/N) [y]: y
lang (channel message locale: en/ko, empty for global): ko
cwd (absolute lane working directory, empty to skip): /Users/me/work/my-project
chat_id (reply target + authorizes that chat for inbound, empty to skip): 12345678
allow_from (extra authorized sender ids, comma-separated, empty to skip):
file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable) [private]:
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
> allowlist/denylist matching is based on the raw tool name the engine reports (e.g. `Bash`, `Write`); a request whose tool name cannot be determined is not auto-allowed and is sent to channel approval (fail-closed). Tool-name provision is currently confirmed for the `claude-code-acp` engine — with an engine that does not provide tool names, every request goes through channel approval even under autopass (the safe direction).
>
> **denylist patterns**: `Tool(glob)` format matches the representative argument — Bash is the command string, Read/Write/Edit the file path, WebFetch the URL. `*` is any string (including path separators) and matches against the whole, so a prefix block is `Bash(git push*)` and a contains block is `Bash(*sudo *)`. A request whose argument cannot be determined, or a tool that doesn't support patterns, goes to channel approval even if only the tool name matches (over-matching = the safe direction). Tool-name comparison is case-insensitive. **Shell chaining**: for Bash, each chained/grouped sub-command (split on `;` `&&` `||` `|` `&`, grouping `(` `)` `{` `}`, `$(…)`, backticks, and newline, leading `VAR=` assignments stripped) is matched too, so a prefix pattern (`sudo *`) catches `echo x && sudo y` and `(sudo y)`. Matching is best-effort, not a full shell parser (no alias/`eval`/variable expansion; wrapper invocations like `bash -c "sudo y"` are not caught; operator characters split even inside quotes, so `--safe-defaults` may refuse a benign command whose quoted argument contains an operator plus a danger token) — if a certain block is needed, specify the whole tool (`Bash`).
>
> **default denylist**: under `--perm-tier autopass`, omitting `--denylist` records into the conf a built-in default list that sends destructive shell commands and credential-store reads back to approval — `Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`. The entries are just a list, not complete defense (see shell chaining above) — tune it to your project.
>
> **hard-deny (`--hard-deny` / `--safe-defaults`)**: the same `Tool(glob)` format as `--denylist`, but its strength differs — denylist removes from auto-allow under `autopass` and **falls back to channel approval**, whereas hard-deny **refuses (cancels) a matching request immediately, regardless of `perm_tier` (including the default `acp`), with no channel prompt at all**. It's the last line of defense that prevents catastrophic commands from being accidentally approved. `--safe-defaults` fills hard-deny with the same danger list as the **default denylist** above (union with any explicit `--hard-deny`). Hard-deny hits are recorded in the transcript and announced to the channel. For concepts and recommended use, see the [permissions guide](permissions.md#hard-deny-outright-refusal).

> **Inbound authentication (telegram)**: inbound messages and permission callbacks are processed only from allowed senders and the rest are ignored (fail-closed). Allowed set = **private `chat_id` (positive = that user, self-authenticated) ∪ `allow_from`**. **A group `chat_id` (negative) is only a reply target and does not authenticate members**, so in a group specify the allowed members' user ids with `--allow-from` (a group chat_id alone does not allow the whole group). With no allowed sender, all inbound is denied. This is the boundary that prevents an arbitrary user with access to the bot from injecting a prompt into the host-executing session or approving permissions without authorization.
>
> **File permissions (`--file-mode`)**: the default `private` locks the lane's state/out/queue/lanes.d directories to 0700 (owner only) to block other local users on a multi-user host from reading the conversation, responses, and config metadata. `shared` is an opt-in that does not apply this lock (keeps the existing umask default — typically 0755); use it only when read sharing is needed. (The bot-token `.env` is always 0600 regardless of mode.)

## completion — shell completion

```bash
adde completion <bash|zsh>
```

Prints a command/flag completion script to stdout (supports macOS-default zsh + bash). It is generated from the command/flag spec, so completion updates automatically as commands grow. The script registers for `adde` plus the short aliases `ad` and `add`.

```bash
# zsh: place on fpath after compinit, or source from .zshrc
adde completion zsh > "${fpath[1]}/_adde"   # or: adde completion zsh >> ~/.zshrc, then re-login

# bash: place in the bash-completion directory, or source from .bashrc
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

**What it completes**:

- **Top-level commands + global flags** — `up`/`down`/…/`lane`/`completion`, and `-h`/`--help`/`-v`/`--version`. In zsh each command shows a short description next to it.
- **Subcommands and fixed values** — `lane add|ls|show|rm|help`, `completion bash|zsh`, the alias-name suggestions after `alias`, `status --all/--json`, `logs --engine`, and the `lane add` option flags.
- **Dynamic project/lane names** — scanned live from `${ADDE_HOME:-~/.config/adde}` (no `adde` process is spawned): a project name at the first position of `up`/`down`/`restart`/`status`/`doctor`/`logs`/`sessions` and `lane ls|show|rm|add` (e.g. `adde up <TAB>`, `adde status <TAB>`), and a lane name at the next position (e.g. `adde logs <proj> <TAB>`, `adde lane show <proj> <TAB>`, `adde sessions <proj> <TAB>`).
- **Enum flag values** — after `--source` (telegram|markdown), `--perm-tier` (acp|autopass), `--file-mode` (private|shared), `--lang` (en|ko).
- **Directory paths** — after `--cwd` and `--root`.

An unsupported shell gives an error + exit code 1.

## Help and typo hints

- `adde <command> --help` (or `-h`) — prints that command's usage and exits with code 0. `adde lane <sub> --help` prints the full lane options.
- An **unsupported command** (typo, etc.) prints `Unknown command` + a nearest-command guess (`Did you mean: …?`) to stderr and exits with code 1 (prevents a typo from silently succeeding in a script).

## Exit codes

| Command      | 0                                                       | 1                                                      |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------ |
| `up`         | Daemon registration succeeded                           | launchd registration failure · missing argument        |
| `down`       | Daemon stop succeeded (0 even if already gone)          | Error occurred                                         |
| `restart`    | Both down+up succeeded                                  | down or up failed                                      |
| `status`     | All healthy                                             | A `dead` (crash) / `stale` (hung) lane exists          |
| `doctor`     | No FAIL                                                 | A FAIL item exists                                     |
| `logs`       | Read succeeded (0 with an info message even if no file) | Missing project/lane argument · path-validation error  |
| `init`       | Wizard completed                                        | Non-TTY · missing argument · validation/creation error |
| `alias`      | Aliases installed · already-set confirmed               | `adde` not found in PATH · install failed              |
| `lane *`     | Success                                                 | Missing argument · validation error                    |
| `completion` | Script output                                           | Missing shell argument · unsupported shell             |

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

**Reboot auto-recovery**: a daemon registered with `adde up` is automatically restarted after a macOS reboot/logout (`KeepAlive`/`RunAtLoad` settings). Confirming recovery yourself with `adde status <proj>` after a reboot is recommended.

**Operational verification checklist**: the items below are outside the automated verification scope and must be confirmed directly on a real macOS environment.

1. `adde up <proj>` → close the terminal → confirm `adde status <proj>` is `running` in a new terminal
2. `adde down <proj>` from another terminal, then confirm `adde status <proj>` is `stopped`
3. After a macOS reboot, `adde status <proj>` — confirm auto-recovery
4. Run `adde up <proj>` twice in a row — confirm no double start (warning printed, then skipped)
5. `adde down <proj>` then `ps aux | grep claude-code-acp` — confirm no orphan process
