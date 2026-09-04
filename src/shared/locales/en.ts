/**
 * English message catalog. 키 구조의 SoT — 타 로케일은 `satisfies typeof en` 으로
 * 키 패리티를 컴파일 타임 강제한다. 보간은 i18next `{{var}}` 문법.
 */
export const en = {
  usage: {
    main: `{{primary}} — AI Driven Development Engine

Usage:
  {{primary}} [command]      main entry point ({{short}} available after 'adde alias')

Commands:
  init [<proj>]                       guided setup (doctor + short alias + create a project)
  up <proj> [--json]                  start all sessions of the project as a background daemon
  down <proj> [--json]                stop the daemon (works from any terminal)
  restart <proj> [--json]             restart the daemon (down + up)
  status [<proj>] [--all] [--json]    session status (all running projects if <proj> omitted, --all includes stopped)
  doctor [<proj>] [--json]            static environment/config checks (state-independent)
  logs <proj> <session> [N] [-f|--follow] [--json]  last N lines of the session transcript (default 50, engine stderr with --engine; -f/--follow to tail live)
  project <add|set|show|ls|rm>        manage projects (run 'adde project help' for options)
  session <new|ls|show|clear|stop|resume|rm>  manage sessions (run 'adde session help' for options)
  bind <add|rm|ls>                    manage channel bindings (run 'adde bind help' for options)
  vault <rebuild>                     regenerate notes/dedup ledger from the event record
  completion <bash|zsh>               print a shell completion script (Tab-complete commands/projects/sessions; run 'adde completion --help' for setup)
  alias [names...]                    install short aliases (default ad, add) next to the adde binary
  factory-reset                       wipe ALL projects and sessions — reset to a fresh install (irreversible, interactive-only)

Options:
  -v, --version            print version
  -h, --help               print help

Run \`{{primary}} <command> --help\` for command-specific help; \`adde project help\` for project options.`,
    up: `Usage: adde up <proj> [--json]

  --json       machine-readable output (boot report: lane statuses + running count; null if inconclusive)`,
    down: `Usage: adde down <proj> [--json]

  --json       machine-readable output ({proj, stopped: true, wasRegistered})`,
    restart: `Usage: adde restart <proj> [--json]

  --json       machine-readable output (boot report: lane statuses + running count; null if inconclusive)`,
    status: "Usage: adde status [<proj>] [--all] [--json]",
    doctor: `Usage: adde doctor [<proj>] [--json]

Static environment/config checks (state-independent).
  --json       machine-readable output ({v, checks}; no summary line/update notice)`,
    logs: `Usage: adde logs <proj> <session> [N] [--engine] [--daemon] [-f|--follow] [--json]

Prints the last N lines (default 50) of a session's log.
  (default)    the session transcript (messages, decisions, notices)
  --engine     the engine's stderr capture (engine.log) — for engine crashes
  --daemon     the launchd daemon log for <proj> (startup failures land here; <session> optional)
  -f, --follow live tail — keeps running and prints new lines as they're appended (Ctrl-C to stop)
  --json       machine-readable output ({proj, sid, path, exists, lines}; takes priority over --follow — snapshot only, no live tail)`,
    sessions: `Usage: adde sessions <proj> <lane> [--json]

Lists the engine sessions recorded for a lane (number, first-prompt excerpt, last activity, id; current marked ◀).
Read-only — resuming/resetting a session is done from the channel (/resume <n> or the resume checkbox), not the CLI.
  --json       machine-readable output (array of sessions)`,
    completion: `Usage: adde completion <bash|zsh>

Prints a shell completion script to stdout — it does NOT install anything.
Why: enables Tab-completion of adde commands, project/lane names, and option values.
What: a script for your shell; you redirect it into your shell's completion directory.
Where/how to decide (check your shell with: echo $SHELL):
  bash → adde completion bash > /usr/local/etc/bash_completion.d/adde   (or add 'source <(adde completion bash)' to ~/.bashrc)
  zsh  → adde completion zsh  > "\${fpath[1]}/_adde"                     (then run compinit; ensure 'autoload -Uz compinit && compinit' is in ~/.zshrc)
Tip: 'adde init' can walk you through this setup.`,
    proj: `Usage:
  adde proj ls [--json]      list registered projects (with lane + running counts)
  adde proj rm <proj>        delete a project — removes ALL its lanes and state

  --json                     machine-readable output (proj ls only)
  --force                    skip the confirmation prompt (required in non-interactive shells; proj rm only)`,
    init: "Usage: adde init [<proj>]  (guided setup: doctor + short alias + create a lane; TTY only)",
    alias: `Usage: adde alias [names...]   (default names: ad add)

Installs short aliases (symlinks) next to the adde binary so you can type e.g. \`ad up <proj>\` instead of \`adde up <proj>\`.
Only works on a global install (needs a writable bin dir next to adde on PATH); if a command with that name already exists it is skipped, not overwritten.`,
    laneAdd: "Usage: adde lane add <proj> <lane> [options]",
    laneSet:
      "Usage: adde lane set <proj> <lane> [<key> <value> ...] [--<field> <value>] [--unset <key> ...]   (no args on a TTY: interactive wizard)\n  Tip: list fields (allowlist/denylist/hard_deny) also support incremental add/remove flags (see adde lane help).",
    laneLs: "Usage: adde lane ls <proj> [--json]",
    laneShow: "Usage: adde lane show <proj> <lane> [key] [--json] [--defaults]",
    laneRm: "Usage: adde lane rm <proj> <lane>",
    daemon: "Usage: adde __daemon <proj> (internal command)",
    project: `Usage:
  adde project add <proj> --vault <path> [options]   create a project (vault path required)
  adde project set <proj> <key> <value>... [--unset <key>...]   edit project settings
  adde project show <proj> [key] [--json] [--defaults]           show settings
  adde project ls [--json]                                        list projects
  adde project rm <proj> --force                                  delete a project (config root only; vault data is preserved)

project add options:
  --vault <path>                 markdown vault root (required)
  --cwd <path>                   project working directory
  --engine <id>                  default engine (default: acp)
  --perm-tier <acp|autopass>     permission tier (default acp)
  --allowlist <a,b,c>            auto-allowed tools
  --denylist <entries,...>       tools that fall back to channel approval under autopass
  --hard-deny <entries,...>      defense-in-depth: tools refused outright
  --safe-defaults                seed hard-deny with the built-in danger list
  --backup <path>                retention backup directory (opt-in)
  --retention-days <n>           retention days (default 2)
  --sync-provider <local|icloud> vault sync provider (default local)

project set incremental list edits:
  --add-allow <a,b,c> / --rm-allow <a,b,c>
  --add-deny <a,b,c> / --rm-deny <a,b,c>
  --add-hard-deny <a,b,c> / --rm-hard-deny <a,b,c>

Editable keys (adde project set <proj> <key> <value>...):
  cwd, engine, engine_args, perm_tier, allowlist, denylist, hard_deny, gate_timeout_sec, lang, file_mode, auto_restart, auto_resume, idle_hibernate, hibernate_after_min, idle_stop, stop_after_min, max_active_engines, auto_relaunch, markdown.palette, markdown.records_cap, markdown.notices_cap, vault.backup, vault.retention_days, vault.sync_provider
  (idle_stop: auto-stop inactive sessions, default on; stop_after_min: minutes of inactivity before auto-stop, default 60; markdown.notices_cap: max notices kept in the input note before pruning, default 10, 0 = unlimited)`,
    session: `Usage:
  adde session new <proj> [--engine <id>] [--title <t>] [--engine-args <args>] [--json]
  adde session ls <proj> [--json]            record view (daemon-independent, sorted by last activity) — for live engine presence use adde status
  adde session show <proj> <sid> [--json]
  adde session clear <proj> <sid>            stop the current session and create a new one (succession — both notes are kept)
  adde session stop <proj> <sid> [--json]    stop watching a session (scheduled if it has pending work)
  adde session resume <proj> [<sid>] [--json]  resume a stopped/detached session (omit <sid> to just see how many are eligible)
  adde session rm <proj> <sid> [--purge]     interactive: full removal / record-only removal / cancel (--purge = non-interactive full removal, no confirmation)`,
    bind: `Usage:
  adde bind add <proj> <sid> --surface <id> --address <addr>
  adde bind rm <proj> <sid> --surface <id> --address <addr>
  adde bind ls <proj> [--json]`,
    vault: `Usage:
  adde vault rebuild <proj> [--sid <sid>] [--json]   regenerate notes/dedup ledger from the event record`,
    factoryReset: `Usage: adde factory-reset

Wipes ALL projects and sessions — resets adde to a fresh-install state.
  - Deletes: every project's config root entries + its vault ADDE subtree (notes, events, blobs, dedup ledgers).
  - Preserves: the vault root itself and anything outside its ADDE namespace; pre-v2 (v0.2.x) data is left untouched.
  - Requires an interactive terminal — refuses in non-interactive shells (fail-closed).
  - Shows an inventory (project/session counts, note paths to be deleted) first, then requires typing a fixed
    confirmation phrase exactly (no yes/no shortcut) — case-sensitive, no retry on mismatch.
  - Stray vault ADDE project directories no longer referenced by any project config are listed and confirmed
    separately (not deleted by default); directories outside every known vault are not discoverable and are
    never touched.
  - A full guarantee against leftover content from before a storage-layout change is only possible via this
    command — a plain \`session rm\` on an old-layout session cannot reach that content (see 'adde session help').`,
    lane: `Usage:
  adde lane add <proj> <lane> [options]   create a lane conf
  adde lane set <proj> <lane> [<key> <value> ...] [--unset <key> ...]  edit an existing lane conf in place (no args on a TTY: interactive wizard)
  adde lane ls <proj> [--json]            list lanes
  adde lane show <proj> <lane> [key] [--json] [--defaults]   print a lane conf (a single key with --json shows value/default/explicit/editable/identity)
  adde lane rm <proj> <lane> [--purge] [--force]    delete a lane conf (--purge also removes its state/queue/out data; --force skips the running-lane guard/confirmation for --purge)

lane add options:
  --source <markdown|telegram>  (default markdown)
  --perm-tier <acp|autopass>    (default acp — channel approval for every tool / autopass — auto-allow except denylist)
  --cwd <abs-path>              lane working directory (project mapping)
  --engine-args <args>          extra CLI args for the engine process, space-separated (e.g. "--model opus")
                                (not for secrets/tokens — visible in the OS process list; quoted values unsupported)
  --allowlist <a,b,c>           auto-allowed tools (gate kept, for perm_tier=acp)
  --denylist <entries,...>      tools/patterns that fall back to channel approval under autopass
                                (e.g. "Bash,Write(/etc/*)" · built-in default list if omitted: blocks sudo, rm -rf, forced git changes, credential reads)
  --hard-deny <entries,...>     defense-in-depth: tools/patterns refused outright (no prompt) for any tier
  --safe-defaults               fill hard-deny with the built-in danger list (sudo, rm -rf, forced git, credential reads)
  --lang <en|ko>                channel message locale for this lane (default: global locale)
  --chat-id <id>                telegram reply target (also authorizes that chat for inbound)
  --allow-from <ids>            extra authorized inbound sender ids (comma-separated user/chat ids)
  --file-mode <private|shared>  state/out/queue dir permissions (default private=0700 owner-only; shared=leave default umask, typically world-readable)
  --token-stdin                 read the telegram bot token from stdin and write it to .env (0600)
  --root <abs-path>             markdown root (e.g. Obsidian vault)
  --inbox <rel> --approvals <rel> --outbox <rel>   markdown note paths
  --force                       overwrite an existing conf
  --interactive                 force the interactive wizard (default on a TTY; the bot token is entered hidden)
  --no-interactive              disable the interactive default and use flags/defaults (for scripts)

lane set options (edit-only subset of lane add — identity fields, tokens, and safe-defaults are not editable; recreate the lane instead):
  --perm-tier <acp|autopass>
  --allowlist <a,b,c>           replaces the whole list (not merged)
  --denylist <entries,...>      replaces the whole list (not merged)
  --hard-deny <entries,...>     replaces the whole list (not merged; warns if it had entries before)
  --add-allow <a,b,c> / --rm-allow <a,b,c>          add to / remove from allowlist (merged with current; vs --allowlist which replaces)
  --add-deny <entries,...> / --rm-deny <entries,...>          add to / remove from denylist
  --add-hard-deny <entries,...> / --rm-hard-deny <entries,...>   add to / remove from hard_deny
  --cwd <abs-path>
  --engine-args <args>
  --lang <en|ko>
  --file-mode <private|shared>
  --chat-id <id>                telegram lanes only
  --allow-from <ids>            telegram lanes only
  --root <abs-path>              markdown lanes only
  --inbox <rel> --approvals <rel> --outbox <rel>   markdown lanes only
  --unset <key> ...             remove keys (dot-notation) to restore their consumer default; identity/required keys are refused

Positional dot-notation keys (adde lane set <proj> <lane> <key> <value> ...) edit the same surface, plus markdown-only extras:
  markdown.archive, markdown.backup, markdown.retention_days, markdown.out_retention_days, markdown.sync_provider, markdown.layout, markdown.palette, markdown.records_cap
Fields left unspecified keep their current value. Changes take effect after adde restart <proj>.
Note: editing --file-mode only updates the conf value; existing directory permissions are NOT changed even after restart (relaxing private→shared needs a manual chmod). file_mode governs only the internal state/out/queue directories, not the markdown note tree.`,
  },
  cli: {
    cmdError: "[adde {{cmd}}] error: {{detail}}",
    laneError: "[adde lane] {{detail}}",
    unknownSub: "Unknown lane subcommand: {{sub}}",
    unknownProjSub: "Unknown proj subcommand: {{sub}}",
    unknownCmd: "Unknown command: {{cmd}}",
    didYouMean: "Did you mean: {{cmds}}?",
    unknownFlag: "unknown option: {{flag}}",
    valueRequired: "{{key}} requires a value",
  },
  completion: {
    unknownShell: 'unsupported shell "{{shell}}" — one of {{supported}}',
    installHint:
      "↳ This printed a completion script, not an installer. To enable it, redirect this into your {{shell}} completion directory (see the comment at the top of the script), or run 'adde completion {{shell}} --help' for the exact path.",
  },
  run: {
    laneStartFailed: {
      situation: 'session "{{sid}}" failed to start: {{error}}',
      action:
        "Check the environment/config with adde doctor {{proj}}, and inspect engine output with adde logs {{proj}} {{sid}} --engine.",
    },
    unknownCause: "unknown cause",
    noLanes: {
      situation: "no lanes to start — {{proj}} has no lane conf",
      action:
        "Create a lane first: adde lane add {{proj}} <lane> --source markdown (or telegram). See adde lane help for options.",
    },
    signalShutdown: "[adde] received {{sig}} — shutting down sessions...",
    shutdownError: {
      situation: "error during shutdown: {{error}}",
      action: "Manually check/stop leftover engine processes (ps | grep claude-agent-acp).",
    },
    upDone: "[adde] {{proj}} daemon registered. Lanes are starting in the background.",
    alreadyUp:
      "[adde] {{proj}} is already up — {{running}}/{{total}} lane(s) running. Nothing to start.",
    alreadyUpHint:
      "  View: adde status {{proj}} · apply conf changes: adde restart {{proj}} · stop: adde down {{proj}}",
    alreadyUpUnhealthy:
      "[adde] {{proj}} has unhealthy lane(s): {{lanes}}\n  ↳ action: inspect with adde status {{proj}} / adde logs {{proj}} --daemon, then adde restart {{proj}}.",
    deadRegistered:
      "[adde] {{proj}} is registered but no lane is running (the daemon died) — reloading it...",
    upFailed:
      "[adde] lane(s) failed to start: {{lanes}}\n  ↳ action: inspect with adde logs {{proj}} <lane> --engine, or the daemon log with adde logs {{proj}} --daemon; then adde restart {{proj}}.",
    upSummary: "  {{running}} running · {{failed}} failed",
    upInconclusive:
      "[adde] no lane came up within the wait window — the daemon may have failed to boot.\n  ↳ action: check the daemon log with adde logs {{proj}} --daemon, then adde restart {{proj}}.",
    pollMsDeprecated:
      "[adde] ADDE_UP_POLL_MS is no longer read — set ADDE_UP_WAIT_MS instead (default 8000ms unchanged if unset).",
    statusHint: "  Check status: adde status {{proj}}",
    downDone: "[adde] {{proj}} daemon stopped.",
    downNotRunning: "[adde] {{proj}}: no daemon registered — nothing to stop.",
    restartDone: "[adde] {{proj}} restarted. Lanes are starting in the background.",
  },
  ops: {
    status: {
      noLanesConf: "no lanes — no conf in lanes.d (adde lane add <proj> <lane>).",
      noLanesRegistered: "no lanes — none registered (adde lane add <proj> <lane>).",
      noRunning:
        "no running lanes — use `adde status --all` to include stopped, or `adde status <proj>` for a project.",
      daemonLine: "daemon {{proj}}: {{state}}",
      daemonState: {
        running: "running",
        stale: "not responding",
        dead: "terminated abnormally",
        stopped: "not started",
        unreadable: "undeterminable",
      },
      daemonDead:
        "warning: the {{proj}} daemon terminated abnormally.\n  ↳ action: clean up state with adde down {{proj}}, then restart with adde up {{proj}}.",
      daemonStale:
        "warning: the {{proj}} daemon is not responding (process alive but periodic refresh stopped).\n  ↳ action: diagnose with adde logs {{proj}} --daemon, then restart with adde restart {{proj}}.",
      daemonUnreadable:
        "warning: cannot determine the {{proj}} daemon state ({{reason}}).\n  ↳ action: clean up with adde down {{proj}}, then adde up {{proj}} to recreate the state record.",
      errorWarnAggregate:
        "error: lane(s) failed to start: {{lanes}}.\n  ↳ action: inspect the daemon log (adde logs <proj> --daemon) or engine log (adde logs <proj> <lane> --engine), then adde restart <proj>.",
      errorWarnSingle:
        "error: lane(s) failed to start: {{lanes}}.\n  ↳ action: inspect the daemon log (adde logs {{proj}} --daemon) or engine log (adde logs {{proj}} <lane> --engine), then adde restart {{proj}}.",
      haltWarn:
        "[adde] {{proj}} self-halted after repeated crash-loop restarts.\n  ↳ action: fix the underlying cause, then adde restart {{proj}}.",
      haltUnreadable:
        "warning: cannot determine the {{proj}} crash-loop halt record ({{reason}}).\n  ↳ action: clean up with adde down {{proj}}, then adde up {{proj}} to recreate the state record.",
    },
    doctor: {
      hint: "    ↳ action: {{hint}}",
      summary: "Summary: {{pass}} PASS / {{warn}} WARN / {{fail}} FAIL / {{info}} INFO",
    },
    sessions: {
      hint: "Resume is done from the channel: send /resume <n> (or check the resume box in a markdown lane).",
    },
    logs: {
      whatEngine: "engine log",
      whatTranscript: "transcript",
      badCount: 'invalid line count "{{raw}}" (must be a positive integer) — falling back to 50.',
      watchError:
        "warning: log change watch failed ({{msg}}) — continuing to track via 1s polling.",
      notFound:
        "{{what}} not found: {{path}}\n  ↳ action: the lane has not been active or started yet. Check with adde status {{proj}}.",
      daemonNotFound:
        "daemon log not found: {{path}}\n  ↳ action: the {{proj}} daemon has not run yet (or logged nothing). Start it with adde up {{proj}}.",
      empty: "({{path}} is empty)",
    },
  },
  lane: {
    retry: {
      chatId: "chat_id — enter a numeric id (or leave empty)",
      allowFrom: "allow_from — enter comma-separated numeric ids (or leave empty)",
      root: "root — required (enter the absolute markdown root path)",
    },
    prompt: {
      source: "source (markdown = drive from note files / telegram = drive from a bot chat)",
      enumHint: "enter a number or the value",
      enumInvalid: "invalid input — enter one of the numbers above or the value itself:",
      permTier:
        "perm_tier (acp = approve each tool in the channel / autopass = auto-allow except denylist)",
      allowlist: "allowlist (comma-separated, empty for none)",
      denylist:
        "denylist (tools/patterns that fall back to channel approval, comma-separated; empty for the recommended default list)",
      safeDefaults:
        "enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright",
      lang: "lang (channel message locale, empty for global)",
      token: "telegram bot token (hidden input, empty to set later)",
      cwd: "cwd (absolute lane working directory, empty to skip)",
      engineArgs:
        "engine_args (extra CLI args for the engine process, space-separated, empty to skip — not a place for secrets: engine args become visible in the OS process list)",
      chatId: "chat_id (reply target + authorizes that chat for inbound, empty to skip)",
      allowFrom: "allow_from (extra authorized sender ids, comma-separated, empty to skip)",
      fileMode:
        "file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable)",
      root: "root (absolute markdown root path, required)",
      inbox: "inbox (relative to root)",
      approvals: "approvals (relative to root, empty for default `approvals/`)",
      outbox: "outbox (relative to root, empty for default `out/`)",
      hardDeny: "hard_deny (tools/patterns refused outright for any tier, comma-separated)",
      archive: "markdown.archive (relative to root; sent bodies relocated here, empty to skip)",
      backup: "markdown.backup (local backup folder path, empty to skip)",
      retentionDays:
        "markdown.retention_days (relocation cutoff in calendar days, empty for default 2)",
      outRetentionDays:
        "markdown.out_retention_days (out/ prune safety window in days; must be retention_days+1 or more, empty to skip)",
      syncProvider: "markdown.sync_provider (local | icloud, empty for default local)",
      layout:
        "markdown.layout (on | off — inbox zoned layout: palette + compose sentinel + records zone + auto-archive on send, empty for default on)",
      palette:
        "markdown.palette (on | off — show the always-present palette markers at the top of the inbox, empty for default on; only relevant when layout=on)",
      recordsCap:
        "markdown.records_cap (max sent/empty markers kept in the records zone before auto-pruning to the most recent 1 + a running archived summary; empty to disable auto-pruning; only relevant when layout=on)",
    },
    ttyOnly: {
      situation: "--interactive only works in an interactive terminal (TTY)",
      action:
        "Specify flags instead (e.g. adde lane add <proj> <lane> --source markdown). See adde lane help for the option list.",
    },
    created: 'lane "{{lane}}" created: {{confPath}}',
    set: {
      updated: 'lane "{{lane}}" updated: {{confPath}}',
      restartHint: "Changes take effect after: adde restart {{proj}}",
      noChange: "no changes — nothing to update.",
      wizardHeader:
        'editing lane "{{lane}}" — leave a field blank to keep its current value (shown in parentheses); use adde lane set ... --unset <key> to restore a default.',
      diffHeader: "changes to apply:",
      diffLine: "  {{key}}: {{from}} → {{to}}",
      confirm: "apply these changes?",
      aborted: "aborted — no changes made.",
    },
    show: {
      line: "{{key}}: value={{value}} default={{default}} explicit={{explicit}} editable={{editable}} identity={{identity}}",
      defaultsHeader: "editable keys (key = default):",
      unset: "(unset)",
    },
    noLanes: "{{proj}}: no lanes",
    removed: 'lane "{{lane}}" removed: {{confPath}}',
    removedPurged: 'lane "{{lane}}" removed with state/queue/out purged: {{confPath}}',
    purgeRunning:
      'lane "{{lane}}" is not safely purgeable (running, or failed while the daemon may still be up) — stop the daemon first (adde down {{proj}}) before --purge, or pass --force to purge anyway.',
    purgeNeedForce:
      "refusing to --purge without confirmation (it deletes state incl. the bot token) — run it in a terminal to confirm, or pass --force.",
    purgeConfirm: 'type the lane name "{{lane}}" to confirm --purge (deletes its state/queue/out)',
    purgeAborted: "aborted — the name did not match.",
    tokenWritten: "token written: {{envPath}} (0600)",
    tokenNext: "Next: put the bot token in {{envPath}} as TELEGRAM_BOT_TOKEN=...",
    startHint: "Start: adde up {{proj}}",
  },
  proj: {
    none: "no projects registered (create one with adde lane add <proj> <lane>).",
    removed: 'project "{{proj}}" deleted: {{path}}',
    notFound: 'project "{{proj}}" not found ({{path}})',
    running:
      'project "{{proj}}" has active lane(s): {{lanes}} — stop the daemon first (adde down {{proj}}), or pass --force to delete anyway.',
    needForce:
      "refusing to delete without confirmation — run it in a terminal to confirm interactively, or pass --force.",
    confirmPrompt:
      'type the project name "{{proj}}" to confirm deletion (removes ALL its lanes and state)',
    aborted: "aborted — the name did not match.",
  },
  doctor: {
    node: {
      name: "Node version",
      hint: "Upgrade to Node 22 or later (e.g. nvm install 22).",
    },
    adapter: {
      name: "ACP adapter binary",
      missing: "no file at resolved path: {{path}}",
      hint: "Install dependencies (pnpm install) — @agentclientprotocol/claude-agent-acp missing.",
    },
    daemonEntry: {
      name: "daemon entry",
      missing: "daemon entry not found: {{path}}",
      hint: "Daemon mode needs a build. Run `pnpm build` and start from dist (`node dist/cli/adde.js up <proj>`), or install globally (`npm i -g .`). `pnpm run dev up` cannot start the daemon.",
    },
    base: {
      name: "config base directory",
      hint: "Created when you add a lane (adde lane add <proj> <lane>).",
    },
    missingPath: "missing: {{path}}",
    daemon: {
      name: "daemon registration ({{proj}})",
      registered: "plist exists + launchctl registered",
      notRunning: "daemon not running (start with adde up {{proj}})",
      plistOnly: "plist exists but not registered in launchctl",
      launchctlOnly: "registered in launchctl but plist missing",
      mismatchHint:
        "Registration mismatch. Re-register with adde down {{proj}} then adde up {{proj}}.",
      queryFailed: "failed to query registration state",
      queryFailedHint:
        "Re-register with adde down {{proj}} then adde up {{proj}}, or check manually with launchctl list | grep com.qwertygeon.adde.{{proj}}.",
    },
    lanes: {
      name: "lanes ({{proj}})",
      none: "no conf in lanes.d",
      addHint: "Add a lane: adde lane add {{proj}} <lane>",
    },
    conf: {
      readFailed: "read failed: {{path}}",
      readFailedHint: "Check the conf file permissions/existence.",
    },
    source: {
      unsupported: 'unsupported source: "{{source}}"',
      hint: "Set source in the conf to markdown or telegram.",
    },
    legacyKeys: {
      detail: "legacy flat adapter keys detected: {{keys}} (ignored)",
      hint: "The conf format changed to namespaced keys — use markdown.root/markdown.inbox, telegram.chat_id/telegram.allow_from. Recreate the lane (adde lane add) or rename the keys.",
    },
    cwd: {
      hint: "Fix cwd in the conf to an existing working directory.",
    },
    token: {
      name: "{{lane}}: token",
      present: "TELEGRAM_BOT_TOKEN present in .env",
      missing: "token missing: {{path}}",
      hint: "Write the bot token: TELEGRAM_BOT_TOKEN=... in {{path}} (or lane add --token-stdin).",
    },
    markdown: {
      name: "{{lane}}: markdown paths",
      ok: "root/inbox configured",
      rootMissing: "markdown lane has no root — the lane will fail to start",
      rootMissingHint: "Set root in the conf (lane add --root <absolute vault path>).",
      rootNotFound: "markdown root path does not exist: {{path}}",
      rootNotFoundHint: "Create the path or fix root in the conf.",
      inboxMissing: "markdown lane has no inbox note — the lane will fail to start",
      inboxMissingHint: "Set inbox in the conf (lane add --inbox <relative note path>).",
    },
    perms: {
      name: "{{lane}}: file permissions",
      ok: "state dir/.env permissions look restrictive",
      envLoose: "state/.env is group/other-accessible (mode {{mode}}) — bot token exposure risk",
      envHint: "Restrict it: chmod 600 {{path}}",
      stateLoose:
        "state dir is group/other-accessible (mode {{mode}}) but file_mode=private is expected to be 0700",
      stateHint:
        "Restrict it: chmod 700 {{path}} — or restart the lane (adde restart {{proj}}) to re-secure it.",
      sharedTight:
        "state dir is not group/other-accessible (mode {{mode}}) but file_mode=shared is declared — perms were not relaxed (fail-closed)",
      sharedTightHint:
        "Safe (tighter than declared). file_mode edits do not loosen existing dirs; to actually relax, chmod the state/out/queue dirs manually: {{path}}",
    },
    halt: {
      name: "self-halt ({{proj}})",
      detail: "self-halted after {{count}} consecutive short-lived crashes — {{reason}}",
      hint: "Fix the underlying cause, then retry with adde restart {{proj}}.",
    },
    deadReg: {
      name: "daemon liveness ({{proj}})",
      detail:
        "registered in launchctl but no lane is running — expected if auto_restart=off after a crash (no auto-restart); otherwise the daemon may have failed to boot",
      hint: "Check adde logs {{proj}} --daemon for the cause, then adde restart {{proj}}.",
    },
  },
  update: {
    available:
      "A new version of adde is available: {{current}} → {{latest}}. Update with `npm i -g adde-acp@latest` (then `adde restart <proj>`).",
  },
  gate: {
    hardDeny:
      "⛔ blocked by hard-deny: {{tool}} — this tool is on the lane's hard-deny list and was refused without a prompt.",
  },
  init: {
    ttyOnly: {
      situation: "adde init needs an interactive terminal (TTY)",
      action:
        "Run it in a terminal, or set up manually: adde doctor / adde lane add <proj> <lane> --interactive / adde alias.",
    },
    intro: "adde setup — environment check, short aliases, and your first lane.",
    doctorWarn:
      "Some checks FAILed above. You can continue, but fix them before starting the daemon (adde up).",
    aliasPrompt: "install short aliases ({{names}}) next to the adde command?",
    completionPrompt:
      "set up shell tab-completion for {{shell}} now? (prints the exact command to run)",
    completionWhat:
      "  Tab-completion lets you complete adde commands, project/lane names, and option values.",
    completionBash:
      "  Run: adde completion bash > /usr/local/etc/bash_completion.d/adde   (or add 'source <(adde completion bash)' to ~/.bashrc, then open a new shell)",
    completionZsh:
      "  Run: adde completion zsh > \"${fpath[1]}/_adde\"   (ensure 'autoload -Uz compinit && compinit' is in ~/.zshrc, then open a new shell)",
    aliasNoBin:
      "could not locate the adde command in PATH — skipping aliases (only available on a global install).",
    aliasCreated: "  ✔ alias created: {{name}} → {{dir}}",
    aliasAlready: "  = alias already points to adde: {{name}}",
    aliasSkipped: "  ✘ skipped {{name}} — a command with that name already exists in PATH",
    aliasFailed: "  ✘ could not create alias {{name}} — {{detail}}",
    projPrompt: "project name",
    projRetry: "project name (letters/digits/_/- only)",
    lanePrompt: "lane name",
    laneRetry: "lane name (letters/digits/_/- only)",
    done: "Setup complete for project '{{proj}}'.",
  },
  laneConfig: {
    warn: {
      cwdMissing:
        "[warning] cwd path does not exist: {{path}}\n  ↳ action: create the folder before starting, or fix cwd in the conf.",
      mdRootMissingConf:
        "[warning] markdown lane has no root.\n  ↳ action: specify --root <absolute vault path> (inbound watching is impossible without it).",
      mdRootNotFound:
        "[warning] markdown root path does not exist: {{path}}\n  ↳ action: check or create the path.",
      mdPathOverlap:
        "[warning] markdown paths overlap (inbox={{inbox}} / approvals={{approvals}} / outbox={{outbox}}) — startup will be refused.\n  ↳ action: separate the approval/output/input paths.",
      tokenFormat:
        "[warning] bot token format looks unexpected (not <digits>:<alphanumerics>).\n  ↳ action: re-check the token issued by BotFather.",
      tokenOverwritten:
        "[warning] --force overwrote the existing bot token in {{envFile}} — the previous token is gone.",
      permTierUnknown:
        '[warning] perm_tier "{{tier}}" is not a known value ({{known}}) — behaves like acp.\n  ↳ action: fix perm_tier in the conf if it is a typo.',
      autopassBanner:
        "[warning] perm_tier=autopass — every tool except the denylist (including file writes and Bash) is auto-allowed without channel confirmation.\n  ↳ put tools that need confirmation on the denylist (e.g. denylist=Bash). Auto-allowed calls are recorded in the transcript.",
      autopassEmptyDeny:
        "[warning] autopass lane has an empty denylist — every permission request passes without confirmation.",
      allowDenyOverlap:
        "[warning] allowlist and denylist share tool(s): {{tools}} — the denylist wins and channel approval is required.\n  ↳ action: remove from one side if unintended.",
      badLang:
        '[warning] lang "{{lang}}" is not a supported locale ({{supported}}) — the global locale applies.\n  ↳ action: fix lang in the conf if it is a typo.',
      telegramNoAuth:
        "[warning] telegram lane has no authorized inbound sender — all inbound will be rejected (fail-closed). A private chat_id self-authorizes, but a group chat_id (negative) is only a reply target and does NOT authorize its members.\n  ↳ action: set --chat-id <your private chat id>, and/or list member ids with --allow-from <ids>.",
      mdBackupNoArchive:
        "[warning] backup is enabled but archive is not configured — inbox content will keep accumulating.\n  ↳ action: set markdown.archive to relocate sent text as well.",
      hardDenyReplaced:
        "[warning] hard_deny was replaced — the previous list is gone (lane set replaces the whole list, it does not merge with the old one).",
      fileModeRelaxNotice:
        "[warning] file_mode changed to shared, but the existing directory permissions (0700) stay unchanged even after adde restart.\n  ↳ action: chmod the lane's state/out/queue directories manually to relax them (file_mode only governs those internal dirs, not the markdown note tree).",
      listRemoveAbsent:
        "[warning] {{key}}: these entries were not in the list, so --rm ignored them: {{tools}}",
    },
    err: {
      emptyIdent: "{{kind}} is empty",
      badIdent: '{{kind}} "{{value}}" is invalid — only letters/digits/_/- allowed',
      badSource: 'source "{{source}}" unsupported — one of {{supported}}',
      unknownEngine: 'engine "{{value}}" unsupported — one of {{known}}',
      unknownBackend: 'backend "{{value}}" unsupported — one of {{known}}',
      invalidEngineArgs: "engine_args is invalid: {{reason}}",
      badChatId: 'chat_id "{{chatId}}" is not a number',
      tokenOnlyTelegram: "token is only used for source=telegram lanes",
      allowFromOnlyTelegram: "allow_from is only used for source=telegram lanes",
      badAllowFrom: 'allow_from entry "{{id}}" is not a number (telegram user/chat id)',
      badFileMode: 'file_mode "{{mode}}" is invalid — one of {{known}}',
      badAllowTool: 'allowlist tool name "{{tool}}" is invalid — only alphanumerics/_/./- allowed',
      badDenyEntry:
        'denylist entry "{{entry}}" is invalid — expected "Bash" or "Bash(git push*)" form (no commas)',
      laneExists: 'lane "{{lane}}" already exists ({{confFile}}) — use --force to overwrite',
      tokenEmpty: "token is empty",
      envHasToken: "{{envFile}} already contains a token — use --force to overwrite",
      laneNotFound: 'lane "{{lane}}" not found ({{confFile}})',
      identityFieldImmutable:
        "{{field}} cannot be changed with lane set — recreate the lane to change it (adde lane rm, then adde lane add).",
      sourceFieldMismatch: "{{field}} does not apply to source={{source}} lanes",
      noEdits: "no edit flags given — nothing to update",
      unsetNoKeys:
        "--unset requires at least one key — usage: adde lane set <proj> <lane> --unset <key> ...",
      denylistNoopAcp:
        "denylist has no effect under perm_tier=acp (acp auto-allows only allowlisted tools; everything else prompts). To use a denylist, also set perm_tier=autopass in the same command.",
      allowlistNoopAutopass:
        "allowlist has no effect under perm_tier=autopass (autopass auto-allows everything except denylist entries). To restrict tools use denylist; to use an allowlist, also set perm_tier=acp in the same command.",
      listIncrementConflict:
        "{{key}}: cannot combine whole-list replacement with incremental add/remove (--add-*/--rm-*) in the same command — use one or the other.",
      listAddRemoveOverlap:
        "{{key}}: the same entries were passed to both add and remove: {{tools}}",
      unknownKey:
        'key "{{key}}" is not an editable lane key — run `adde lane show <proj> <lane> --defaults` to list editable keys',
      unknownKeyDidYouMean:
        'key "{{key}}" is not an editable lane key — did you mean: {{suggestions}}?',
      badIntValue: '{{key}} must be a positive integer — got "{{value}}"',
      badEnumValue: '{{key}} "{{value}}" is invalid — one of {{allowed}}',
      requiredUnset:
        'key "{{key}}" is required and cannot be unset (recreate the lane to change it)',
      keyValueIncomplete:
        "each key needs a value — usage: adde lane set <proj> <lane> <key> <value> ...",
    },
  },
  telegram: {
    permPrompt: "Permission request: {{tool}}\n{{detail}}",
    permPromptCwd: "📁 cwd: {{cwd}}",
    permPromptDeadline: "🕒 auto-deny at {{deadline}} if no response",
    permAllowed: "✅ Allowed",
    permDenied: "⛔ Denied",
    permBtnAllow: "Allow",
    permBtnDeny: "Deny",
    nonTextUnsupported: "⚠️ Only text messages are supported. Please send your request as text.",
    enqueueFail: {
      situation: "enqueueing inbound messages has failed {{count}} times in a row",
      action:
        "Check server disk space and state directory permissions. Inbound messages may not be processed until this is resolved.",
    },
  },
  markdown: {
    enqueueFail: {
      situation: "enqueueing inbound messages has failed {{count}} times in a row",
      action:
        "Check server disk space and state directory permissions. Inbox instructions may not be processed until this is resolved.",
    },
    confRootMissing: "[markdown] conf.root missing — absolute markdown root path required",
    confInboxMissing: "[markdown] conf.inbox missing — input note (relative to root) required",
    rootNotFound: "[markdown] root path not found: {{path}}",
    pathNotRelative:
      "[markdown] {{name}} path must be relative to root — '..' and absolute paths forbidden: {{rel}}",
    controlNoteInCwd:
      "[markdown] control note ({{name}}) is inside the AI working directory: {{path}} (cwd={{cwd}}) — self-approval risk, move it outside cwd",
    pathsOverlap:
      "[markdown] {{nameA}}({{a}}) and {{nameB}}({{b}}) are identical or nested — output/alert/quarantine notes would be picked up by approval/input watching. Separate the paths.",
    inboxInsideDir:
      "[markdown] input note ({{inbox}}) is inside the {{name}} directory ({{dir}}) — input/control paths overlap. Separate the paths.",
    badApprovalId:
      'invalid approval request id "{{reqId}}" — path escape blocked (fail-closed deny).',
    outMeta: "🕒 sent {{sent}} · done {{done}}",
    approvalMeta: "🕒 requested {{requested}} · auto-deny at {{deadline}} if no response",
    approvalHint: "check exactly one box below — allow or deny (leaving both keeps it pending)",
    backupPathOverlap:
      "[markdown] backup path overlaps {{name}}({{path}}): {{backup}} — refusing startup to avoid corrupting vault/state.",
    syncProviderUnsupported:
      '[markdown] unsupported sync_provider "{{value}}" — supported: {{supported}}',
    outRetentionTooLow:
      "[markdown] out_retention_days({{outRetentionDays}}) must be >= retention_days({{retentionDays}}) + {{margin}} — refusing startup.",
    backupNoArchiveWarn:
      "⚠️ backup relocation is on but archive is not configured — inbox content keeps accumulating (archived text is not relocated). Set markdown.archive to enable archiving.",
    recordsHeading: "Sent history",
  },
  supervisor: {
    noLanesMsg: "{{proj}}: 0 lanes — no conf in lanes.d",
    alreadyRunning:
      '[adde] lane "{{lane}}" already running (pid {{pid}})\n  ↳ action: adde down {{proj}} then restart, or check adde status {{proj}}',
    autopassDenySome: "only denylist({{tools}}) tools go through channel approval",
    autopassDenyEmpty:
      "the denylist is empty, so every permission request passes without confirmation",
    autopassBanner: {
      situation:
        "this project started in auto-allow mode (perm_tier=autopass) — {{denyDesc}}. All other tools (including file writes and Bash) are auto-allowed",
      action:
        "Add tools that need confirmation with adde project set {{proj}} --add-deny <tool>. Auto-allowed calls can be reviewed with adde logs {{proj}} <session>.",
    },
    upStarted: "{{proj}}: {{count}} lane(s) started",
    upSkipped: "{{count}} already running (skipped)",
    downStopped: "{{proj}}: {{count}} lane(s) stopped",
    source: {
      unknown:
        'unknown source "{{source}}" — not a registered source. Fix source= in lanes.d/<lane>.conf (see adde doctor for supported sources).',
    },
    engineWiring: {
      unknownEngine:
        'unsupported engine "{{value}}" (known: {{known}}) — fix engine= in lanes.d/<lane>.conf.',
      unknownBackend:
        'unsupported backend "{{value}}" (known: {{known}}) — fix backend= in lanes.d/<lane>.conf.',
    },
    engineArgs: {
      parseFail:
        "engine_args parsing failed: {{detail}} — quoted values are not supported (space-separated only); fix engine_args= in lanes.d/<lane>.conf.",
    },
    selfRecovery: {
      attempt: "⚠️ engine crashed on lane {{lane}} — attempting auto-recovery (backoff)…",
      abandoned:
        "🛑 lane {{lane}} auto-recovery gave up after {{attempts}} attempts — status set to error. Recover with adde restart {{proj}}.",
      disabled:
        "🛑 engine crashed on lane {{lane}} — auto-relaunch is off (auto_relaunch=false); status set to error, no restart attempted. Recover with adde restart {{proj}}.",
    },
  },
  launchd: {
    macOnly: {
      situation: "launchd features only work on macOS (current platform: {{platform}})",
      action: "Run on macOS. Linux/WSL support is a future spec scope.",
    },
    loadFail: {
      situation: "launchctl load failed (exit {{code}}): {{output}}",
      action:
        "Check registration state with adde doctor {{proj}}, or unload the existing registration first (adde down {{proj}}).",
    },
    binMissing: {
      situation: "daemon entry not found: {{path}}",
      action:
        "Daemon mode needs a build — run `pnpm build` and start from dist (`node dist/cli/adde.js up <proj>`), or install globally (`npm i -g .`) and run `adde up <proj>`. `pnpm run dev up` cannot start the daemon (launchd spawns a detached process that tsx cannot transpile).",
    },
  },
  queue: {
    claimFail: {
      situation: "queue message claim failed ({{code}}): {{path}}",
      action:
        "Check disk space, file permissions, and mounts (NFS/EBUSY). The message stays in the queue and is retried on the next signal.",
    },
    quarantined: "corrupt message quarantined @ {{ts}}: {{detail}}",
  },
  outLedger: {
    readFail: {
      situation: "out-state ledger read failed ({{path}}): {{error}}",
      action:
        "Check disk/permission issues. Treated as an empty ledger for this operation (conservative — non-idempotent lanes will not resend in-flight messages until the file is restored).",
    },
    corrupt: {
      situation: "out-state ledger parse failed ({{path}}): {{error}}",
      action:
        "The file may be externally corrupted (disk error, manual edit, sync conflict). Treated as an empty ledger for this operation (in-flight non-idempotent lane responses may not be resent — duplicate-avoidance direction). Restore from a backup if available.",
    },
    unknownVersion: {
      situation: "out-state ledger schema version unrecognized ({{path}}, v={{v}})",
      action:
        "This may be a file from a newer ADDE version. Known fields are read on a best-effort basis; verify behavior after a downgrade.",
    },
  },
  injector: {
    injectFailed: "inject failed @ {{ts}}: {{detail}}",
    control: {
      cleared: "🧹 Started a fresh session — previous conversation context was cleared.",
      compacted: "✂️ Conversation context compacted (/compact).",
      resumed: "⏪ Resumed session {{id}}.",
      resumeFallback: "⚠️ Could not resume session {{id}} — started a fresh session instead.",
      resumeMissing: "⚠️ No session id to resume — list sessions and pick one.",
      unsupported: "⚠️ This backend does not support session control.",
      relaunchFailed:
        "🛑 Session control failed — engine relaunch error: {{error}}. The lane may be down; recover with `adde restart <proj>`.",
      sessionsHeader: "📋 Recent sessions (current marked ◀):",
      sessionsItem: "{{n}}. {{label}} — last activity {{last}} ({{id}})",
      sessionsNoLabel: "(no prompt yet)",
      sessionsEmpty: "📋 No recorded sessions yet.",
      sessionsHint: "Resume with: resume <n> (checkbox label) or /resume <n>.",
    },
    failNote: {
      situation: "message processing failed — id {{id}}: {{detail}}",
      action:
        "The message is preserved and will be reprocessed on restart. If it recurs, check the transcript and logs.",
    },
    deliverUncertain:
      "⚠️ The process was interrupted mid-send — delivery of this reply (id {{id}}) is uncertain. It will not be resent, to avoid duplicates. If it didn't arrive, please ask again.",
  },
  transcript: {
    commandsUpdated: "[{{ts}}] commands_update: (updated)",
  },
  acp: {
    spawnFail: {
      situation: "engine process spawn failed ({{bin}}): {{error}}",
      action: "Check the adapter binary installation (pnpm install), then retry adde up.",
    },
    handshakeTimeout: {
      situation: "engine handshake ({{phase}}) got no response within {{seconds}}s",
      action: "Check the engine binary/health, then retry adde up.",
    },
    subscriberError: "subscriber processing error: {{error}}",
    bypassAction:
      "The gate may be neutralized — disable bypassPermissions in the engine permission settings or align them with the ADDE policy (perm_tier). Startup continues.",
  },
  permDiff: {
    queryFailedMsg:
      "failed to query effective engine settings — unverifiable (conservatively treated as a difference)",
    warnLine:
      "[ADDE WARN] permission settings differ: {{reason}} | adde.perm_tier={{tier}} | engine={{engine}}",
    looseEngine: "engine settings looser than the ADDE policy (acp) detected",
    bypassMsg:
      "engine bypass — permission requests never fire, neutralizing the autopass denylist and auto-allow audit trail",
    engineUnknown: "(query failed)",
  },
  log: {
    supervisor: {
      noConf: "[supervisor] {{proj}}: no conf in lanes.d",
      legacyKeys:
        "[supervisor] lane={{lane}} legacy flat adapter keys ignored: {{keys}} — conf format changed to namespaced keys (markdown.*/telegram.*). Recreate the lane or rename the keys.",
      ledgerFail: "[supervisor] lane={{lane}} session ledger update failed (auxiliary): {{error}}",
      deadCleanupFail:
        "[supervisor] lane={{lane}} dead runtime.json cleanup failed (auxiliary): {{error}}",
      channelWarnFail:
        "[supervisor] lane={{lane}} channel warning delivery failed (auxiliary): {{error}}",
      injectorStartFail: "[supervisor] lane={{lane}} injector start error: {{error}}",
      securePermsFail:
        "[supervisor] proj={{proj}} internal directory permission lock failed (files may be world-readable): {{error}}",
      laneStartFail: "[supervisor] lane={{lane}} start failed: {{reason}}",
      laneCleanupFail:
        "[supervisor] lane={{lane}} failed-start cleanup (engine close) failed (auxiliary): {{error}}",
    },
    liveness: {
      writeFail: "[liveness] proj={{proj}} liveness record write failed (auxiliary): {{error}}",
      refreshFail:
        "[liveness] proj={{proj}} liveness periodic refresh failed (auxiliary): {{error}}",
      removeFail: "[liveness] proj={{proj}} liveness record removal failed (auxiliary): {{error}}",
    },
    queue: {
      quarantineFail: "[queue] corrupt message quarantine failed id={{id}}: {{code}}",
      failedWriteFail: "[queue] .failed write failed id={{id}}: {{error}}",
    },
    injector: {
      injectError: "[injector] inject error lane={{lane}} id={{id}}: {{detail}}",
      failedWriteFail: "[injector] .failed write failed lane={{lane}} id={{id}}: {{error}}",
      renderError:
        "[injector] render error lane={{lane}} id={{id}} — awaiting redelivery: {{error}}",
      advanceError: "[injector] advance error lane={{lane}}: {{error}}",
      failNotifyError:
        "[injector] failure notice delivery error lane={{lane}} id={{id}}: {{error}}",
      uncertainNotifyError:
        "[injector] uncertain-delivery notice error lane={{lane}} id={{id}}: {{error}}",
      relaunchError:
        "[injector] session-control engine relaunch failed lane={{lane}} — the lane may be down until restart: {{error}}",
    },
    telegram: {
      rateLimit: "[telegram] {{method}} 429 rate limited — retrying in {{waitMs}}ms ({{attempt}})",
      enqueueError: "[telegram] enqueue error ({{count}} in a row): {{error}}",
      answerCallbackError: "[telegram] answerCallbackQuery error: {{error}}",
      nonTextReplyError: "[telegram] non-text reply failed: {{error}}",
      unknownCallback: "[telegram] ignoring unknown callback decision: {{decision}}",
      unauthorizedMessage:
        "[telegram] ignoring inbound from unauthorized sender (from={{from}} chat={{chat}}) — add to chat_id/allow_from to authorize",
      unauthorizedCallback:
        "[telegram] ignoring permission callback from unauthorized sender (from={{from}})",
      noAuthConfigured:
        "[telegram] no authorized senders configured (chat_id/allow_from empty) — all inbound is rejected (fail-closed)",
      pollError: "[telegram] poll error ({{count}} in a row, retrying in {{backoff}}ms): {{error}}",
      alertSendError: "[telegram] enqueue failure alert delivery error: {{error}}",
      pollLoopEnd: "[telegram] poll loop ended: {{error}}",
    },
    markdown: {
      quarantineFail: "[markdown] conflict file quarantine failed {{filename}}: {{error}}",
      enqueueError:
        "[markdown] enqueue error ({{count}} in a row) lane={{lane}} id={{id}}: {{error}}",
      alertWriteError: "[markdown] enqueue failure alert write error: {{error}}",
      inboxError: "[markdown] inbox processing error: {{error}}",
      approvalsError: "[markdown] approvals processing error: {{error}}",
      pollError: "[markdown] polling error: {{error}}",
      decidedMoveError: "[markdown] failed to archive decided approval {{file}}: {{error}}",
      backupWarnNotifyFail: "[markdown] failed to write backup/archive warning notice: {{error}}",
      legacyArchiveMoveError:
        "[markdown] failed to relocate legacy archive file {{path}}: {{error}}",
      archiveWriteError:
        "[markdown] lane={{lane}} auto-archive write failed (falling back to keeping the body in the inbox — no loss): {{error}}",
    },
    markdownRetention: {
      relocateFail:
        "[markdown-retention] relocate failed {{src}} -> {{dst}}: {{error}} (fail-open, continuing)",
      migrateOutboxFail:
        "[markdown-retention] outbox migration failed {{name}}: {{error}} (fail-open)",
      migrateDecidedMtimeFail:
        "[markdown-retention] decided mtime lookup failed {{name}}: {{error}} (fail-open)",
      migrateDecidedFail:
        "[markdown-retention] decided migration failed {{name}}: {{error}} (fail-open)",
      maintenanceFail:
        "[markdown-retention] lane={{lane}} maintenance run failed: {{error}} (fail-open)",
      lastRunWriteFail:
        "[markdown-retention] lane={{lane}} failed to persist retention-last-run: {{error}}",
    },
    transcript: {
      auditAppendFail:
        "[transcript] audit event ({{kind}}) append failed — audit trail incomplete: {{detail}}",
      appendFail: "[transcript] append failed (auxiliary — absorbed): {{detail}}",
    },
    acp: {
      engineProcessError: "[acp] lane={{lane}} engine process error: {{error}}",
      loadSessionFail:
        "[acp] lane={{lane}} session resume (session/load) failed — falling back to a new session: {{error}}",
      subscriberError: "[acp] lane={{lane}} subscriber error: {{error}}",
      transcriptWriteFail: "[acp] lane={{lane}} transcript write failed: {{error}}",
      permDiff: "[acp] launch perm-diff: {{note}}",
    },
    rotate: {
      fail: "[log-rotate] rotation failed for {{path}} (absorbed — logging continues): {{detail}}",
    },
  },
  notify: {
    block: "[ADDE blocked] {{situation}}\n  ↳ action: {{action}}",
    exception: "[ADDE error] {{situation}}\n  ↳ action: {{action}}",
    warn: "[ADDE warning] {{situation}}\n  ↳ action: {{action}}",
  },
  notice: {
    // 안내 존 항목이 노트에 아직 렌더되기 전에 사용자가 지워도(crash-consistency — 렌더 확정 전
    // 부재는 취소/읽음으로 보지 않는다) 침묵 없이 알린다: 항목은 되살아나지만 다시 지우면
    // 의도대로 처리된다.
    notYetReflected:
      "This action hadn't been written to the note yet, so it wasn't recognized — the item will reappear. To cancel/dismiss it, delete it again once it's shown.",
    // clear() 로 중지된 이전 세션의 노트 배너 쓰기가 실패했을 때 — old 는 폴 대상 제외라 경고가
    // 보일 계기가 없으므로 승계된 새 세션(이 경고가 뜨는 세션) 쪽에 낸다.
    successionNoteFailed:
      "The note update for the previous session ({{oldSid}}) failed — it will retry automatically. If it keeps failing, check that session's note file directly.",
  },
};
