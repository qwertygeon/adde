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
  init [<proj>]            guided setup (doctor + short alias + create a lane)
  up <proj>                start all lanes of the project as a background daemon
  down <proj>              stop the daemon (works from any terminal)
  restart <proj>           restart the daemon (down + up)
  status [<proj>] [--all]  lane status (all running projects if <proj> omitted, --all includes stopped)
  doctor [<proj>]          static environment/config checks (state-independent)
  logs <proj> <lane> [N]   last N lines of the lane transcript (default 50, engine stderr with --engine)
  sessions <proj> <lane>   list recorded engine sessions (resume via channel: /resume or resume checkbox)
  lane add <proj> <lane>   create a lane conf
  lane ls <proj>           list lanes
  lane show <proj> <lane>  print a lane conf
  lane rm <proj> <lane>    delete a lane conf (--purge also removes state/queue/out)
  proj ls                  list registered projects (with lane + running counts)
  proj rm <proj>           delete a project (all its lanes + state; asks to confirm)
  completion <bash|zsh>    print a shell completion script (Tab-complete commands/projects/lanes; run 'adde completion --help' for setup)
  alias [names...]         install short aliases (default ad, add) next to the adde binary

Options:
  -v, --version            print version
  -h, --help               print help

Run \`{{primary}} <command> --help\` for command-specific help; \`adde lane help\` for lane options.`,
    up: "Usage: adde up <proj>",
    down: "Usage: adde down <proj>",
    restart: "Usage: adde restart <proj>",
    status: "Usage: adde status [<proj>] [--all] [--json]",
    doctor: "Usage: adde doctor [<proj>]",
    logs: `Usage: adde logs <proj> <lane> [N] [--engine] [--daemon]

Prints the last N lines (default 50) of a lane's log.
  (default)    the lane transcript (messages, decisions, notices)
  --engine     the engine's stderr capture (engine.log) — for engine crashes
  --daemon     the launchd daemon log for <proj> (startup failures land here; <lane> optional)`,
    sessions: `Usage: adde sessions <proj> <lane>

Lists the engine sessions recorded for a lane (number, first-prompt excerpt, last activity, id; current marked ◀).
Read-only — resuming/resetting a session is done from the channel (/resume <n> or the resume checkbox), not the CLI.`,
    completion: `Usage: adde completion <bash|zsh>

Prints a shell completion script to stdout — it does NOT install anything.
Why: enables Tab-completion of adde commands, project/lane names, and option values.
What: a script for your shell; you redirect it into your shell's completion directory.
Where/how to decide (check your shell with: echo $SHELL):
  bash → adde completion bash > /usr/local/etc/bash_completion.d/adde   (or add 'source <(adde completion bash)' to ~/.bashrc)
  zsh  → adde completion zsh  > "\${fpath[1]}/_adde"                     (then run compinit; ensure 'autoload -Uz compinit && compinit' is in ~/.zshrc)
Tip: 'adde init' can walk you through this setup.`,
    proj: `Usage:
  adde proj ls               list registered projects (with lane + running counts)
  adde proj rm <proj>        delete a project — removes ALL its lanes and state

  --force                    skip the confirmation prompt (required in non-interactive shells)`,
    init: "Usage: adde init [<proj>]  (guided setup: doctor + short alias + create a lane; TTY only)",
    alias: `Usage: adde alias [names...]   (default names: ad add)

Installs short aliases (symlinks) next to the adde binary so you can type e.g. \`ad up <proj>\` instead of \`adde up <proj>\`.
Only works on a global install (needs a writable bin dir next to adde on PATH); if a command with that name already exists it is skipped, not overwritten.`,
    laneAdd: "Usage: adde lane add <proj> <lane> [options]",
    laneLs: "Usage: adde lane ls <proj>",
    laneShow: "Usage: adde lane show <proj> <lane>",
    laneRm: "Usage: adde lane rm <proj> <lane>",
    daemon: "Usage: adde __daemon <proj> (internal command)",
    lane: `Usage:
  adde lane add <proj> <lane> [options]   create a lane conf
  adde lane ls <proj>                     list lanes
  adde lane show <proj> <lane>            print a lane conf
  adde lane rm <proj> <lane> [--purge]    delete a lane conf (--purge also removes its state/queue/out data)

lane add options:
  --source <markdown|telegram>  (default markdown)
  --engine <name>               (default claude-agent-acp)
  --backend <name>              (default acp)
  --perm-tier <acp|autopass>    (default acp — channel approval for every tool / autopass — auto-allow except denylist)
  --acp-version <v>             (default v1)
  --cwd <abs-path>              lane working directory (project mapping)
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
  --no-interactive              disable the interactive default and use flags/defaults (for scripts)`,
  },
  cli: {
    cmdError: "[adde {{cmd}}] error: {{detail}}",
    laneError: "[adde lane] {{detail}}",
    unknownSub: "Unknown lane subcommand: {{sub}}",
    unknownCmd: "Unknown command: {{cmd}}",
    didYouMean: "Did you mean: {{cmds}}?",
  },
  completion: {
    unknownShell: 'unsupported shell "{{shell}}" — one of {{supported}}',
    installHint:
      "↳ This printed a completion script, not an installer. To enable it, redirect this into your {{shell}} completion directory (see the comment at the top of the script), or run 'adde completion {{shell}} --help' for the exact path.",
  },
  run: {
    laneStartFailed: {
      situation: 'lane "{{lane}}" failed to start: {{error}}',
      action:
        "Check the environment/config with adde doctor {{proj}}, and inspect engine output with adde logs {{proj}} {{lane}} --engine.",
    },
    unknownCause: "unknown cause",
    noLanes: {
      situation: "no lanes to start — {{proj}} has no lane conf",
      action:
        "Create a lane first: adde lane add {{proj}} <lane> --source markdown (or telegram). See adde lane help for options.",
    },
    signalShutdown: "[adde] received {{sig}} — shutting down lanes...",
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
    upFailed:
      "[adde] lane(s) failed to start: {{lanes}}\n  ↳ action: inspect with adde logs {{proj}} <lane> --engine, or the daemon log with adde logs {{proj}} --daemon; then adde restart {{proj}}.",
    upSummary: "  {{running}} running · {{failed}} failed · {{pending}} still starting",
    upInconclusive:
      "[adde] no lane came up within the wait window — the daemon may have failed to boot.\n  ↳ action: check the daemon log with adde logs {{proj}} --daemon, then adde restart {{proj}}.",
    statusHint: "  Check status: adde status {{proj}}",
    downDone: "[adde] {{proj}} daemon stopped.",
    restartDone: "[adde] {{proj}} restarted. Lanes are starting in the background.",
  },
  ops: {
    status: {
      noLanesConf: "no lanes — no conf in lanes.d (adde lane add <proj> <lane>).",
      noLanesRegistered: "no lanes — none registered (adde lane add <proj> <lane>).",
      noRunning:
        "no running lanes — use `adde status --all` to include stopped, or `adde status <proj>` for a project.",
      deadWarnAggregate:
        "warning: lane(s) {{lanes}} terminated abnormally (dead).\n  ↳ action: clean up with adde down <proj>, then restart with adde up <proj>.",
      staleWarnAggregate:
        "warning: lane(s) {{lanes}} not responding (stale — heartbeat lost).\n  ↳ action: diagnose with adde logs <proj> <lane> --engine, then restart with adde down/up <proj>.",
      deadWarnSingle:
        "warning: lane(s) {{lanes}} terminated abnormally (dead).\n  ↳ action: clean up state with adde down {{proj}}, then restart with adde up {{proj}}.",
      staleWarnSingle:
        "warning: lane(s) {{lanes}} not responding (stale — process alive but heartbeat lost).\n  ↳ action: possible hang. Diagnose with adde logs {{proj}} <lane> --engine, then restart with adde down/up {{proj}}.",
      errorWarnAggregate:
        "error: lane(s) failed to start: {{lanes}}.\n  ↳ action: inspect the daemon log (adde logs <proj> --daemon) or engine log (adde logs <proj> <lane> --engine), then adde restart <proj>.",
      errorWarnSingle:
        "error: lane(s) failed to start: {{lanes}}.\n  ↳ action: inspect the daemon log (adde logs {{proj}} --daemon) or engine log (adde logs {{proj}} <lane> --engine), then adde restart {{proj}}.",
    },
    doctor: {
      hint: "    ↳ action: {{hint}}",
      summary: "Summary: {{pass}} PASS / {{warn}} WARN / {{fail}} FAIL",
    },
    logs: {
      whatEngine: "engine log",
      whatTranscript: "transcript",
      notFound:
        "{{what}} not found: {{path}}\n  ↳ action: the lane has not been active or started yet. Check with adde status {{proj}}.",
      daemonNotFound:
        "daemon log not found: {{path}}\n  ↳ action: the {{proj}} daemon has not run yet (or logged nothing). Start it with adde up {{proj}}.",
      empty: "({{path}} is empty)",
    },
  },
  lane: {
    valueRequired: "--{{key}} requires a value",
    retry: {
      chatId: "  chat_id — enter a numeric id (or leave empty)",
      allowFrom: "  allow_from — enter comma-separated numeric ids (or leave empty)",
    },
    prompt: {
      source: "source (enter a number or the value)",
      permTier:
        "perm_tier (acp = approve each tool in the channel / autopass = auto-allow except denylist)",
      allowlist: "allowlist (comma-separated, empty for none)",
      denylist: "denylist (tools/patterns that fall back to channel approval, comma-separated)",
      safeDefaults:
        "enable safe-defaults hard-deny? blocks sudo / rm -rf / git force / credential reads outright (y/N)",
      lang: "lang (channel message locale, empty for global)",
      token: "telegram bot token (hidden input, empty to set later)",
      cwd: "cwd (absolute lane working directory, empty to skip)",
      chatId: "chat_id (reply target + authorizes that chat for inbound, empty to skip)",
      allowFrom: "allow_from (extra authorized sender ids, comma-separated, empty to skip)",
      fileMode:
        "file_mode (private=owner-only 0700 / shared=leave default umask, typically world-readable)",
      root: "root (absolute markdown root path)",
      inbox: "inbox (relative to root)",
      approvals: "approvals (relative to root, default if empty)",
      outbox: "outbox (relative to root, default if empty)",
    },
    ttyOnly: {
      situation: "--interactive only works in an interactive terminal (TTY)",
      action:
        "Specify flags instead (e.g. adde lane add <proj> <lane> --source markdown). See adde lane help for the option list.",
    },
    created: 'lane "{{lane}}" created: {{confPath}}',
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
    aliasPrompt: "install short aliases ({{names}}) next to the adde command? (Y/n)",
    completionPrompt:
      "set up shell tab-completion for {{shell}} now? (prints the exact command to run) (Y/n)",
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
    },
    err: {
      emptyIdent: "{{kind}} is empty",
      badIdent: '{{kind}} "{{value}}" is invalid — only letters/digits/_/- allowed',
      badSource: 'source "{{source}}" unsupported — one of {{supported}}',
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
    },
  },
  telegram: {
    permPrompt: "Permission request: {{tool}}\n{{detail}}",
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
        "this lane started in auto-allow mode (perm_tier=autopass) — {{denyDesc}}. All other tools (including file writes and Bash) are auto-allowed",
      action:
        "Add tools that need confirmation to the denylist in lanes.d/{{lane}}.conf. Auto-allowed calls can be reviewed with adde logs {{proj}} {{lane}}.",
    },
    upStarted: "{{proj}}: {{count}} lane(s) started",
    upSkipped: "{{count}} already running (skipped)",
    downStopped: "{{proj}}: {{count}} lane(s) stopped",
    source: {
      unknown:
        'unknown source "{{source}}" — not a registered source. Fix source= in lanes.d/<lane>.conf (see adde doctor for supported sources).',
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
      heartbeatFail: "[supervisor] lane={{lane}} heartbeat touch failed (auxiliary): {{error}}",
      ledgerFail: "[supervisor] lane={{lane}} session ledger update failed (auxiliary): {{error}}",
      deadCleanupFail:
        "[supervisor] lane={{lane}} dead runtime.json cleanup failed (auxiliary): {{error}}",
      channelWarnFail:
        "[supervisor] lane={{lane}} channel warning delivery failed (auxiliary): {{error}}",
      injectorStartFail: "[supervisor] lane={{lane}} injector start error: {{error}}",
      runtimeWriteFail:
        "[supervisor] lane={{lane}} runtime.json write failed (auxiliary): {{error}}",
      runtimeRemoveFail:
        "[supervisor] lane={{lane}} runtime.json removal failed (auxiliary): {{error}}",
      securePermsFail:
        "[supervisor] lane={{lane}} state directory permission lock failed (auxiliary — files may be world-readable): {{error}}",
      laneStartFail: "[supervisor] lane={{lane}} start failed: {{reason}}",
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
      relaunchError:
        "[injector] session-control engine relaunch failed lane={{lane}} — the lane may be down until restart: {{error}}",
    },
    telegram: {
      rateLimit: "[telegram] {{method}} 429 rate limited — retrying in {{waitMs}}ms ({{attempt}})",
      enqueueError: "[telegram] enqueue error ({{count}} in a row): {{error}}",
      answerCallbackError: "[telegram] answerCallbackQuery error: {{error}}",
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
  },
  notify: {
    block: "[ADDE blocked] {{situation}}\n  ↳ action: {{action}}",
    exception: "[ADDE error] {{situation}}\n  ↳ action: {{action}}",
    warn: "[ADDE warning] {{situation}}\n  ↳ action: {{action}}",
  },
};
