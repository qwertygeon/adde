/**
 * 한국어 메시지 카탈로그. `satisfies typeof en` 으로 en 과의 키 패리티를 컴파일 타임 강제.
 */
import type { en } from "./en.js";

export const ko = {
  usage: {
    main: `{{primary}} — AI Driven Development Engine

사용법:
  {{primary}} [command]      주 진입점 ('adde alias' 후 {{short}} 사용 가능)

명령:
  init [<proj>]            가이드 설정 (doctor + 짧은 별칭 + 레인 생성)
  up <proj>                프로젝트의 모든 레인 백그라운드 데몬으로 기동
  down <proj>              데몬 종료 (어느 터미널에서든 동작)
  restart <proj>           데몬 재기동 (down + up)
  status [<proj>] [--all] [--json]  레인 상태 조회 (<proj> 생략 시 실행 중 전체, --all 정지 포함)
  doctor [<proj>] [--json]  환경·설정 정적 점검(상태 비의존)
  logs <proj> <lane> [N] [-f|--follow]  레인 transcript 최근 N줄(기본 50, --engine 시 엔진 stderr; -f/--follow 로 실시간 추적)
  sessions <proj> <lane> [--json]  기록된 엔진 세션 목록(재개는 채널에서: /resume 또는 resume 체크박스)
  lane add <proj> <lane>   레인 conf 생성
  lane ls <proj>           레인 목록
  lane show <proj> <lane>  레인 conf 출력
  lane rm <proj> <lane>    레인 conf 삭제 (--purge 시 state/queue/out 도 삭제)
  proj ls                  등록된 프로젝트 목록(레인·실행 수 포함)
  proj rm <proj>           프로젝트 삭제(모든 레인 + state; 확인 후 삭제)
  completion <bash|zsh>    셸 자동완성 스크립트 출력(명령·프로젝트/레인 Tab 완성; 설정은 'adde completion --help')
  alias [names...]         짧은 별칭 설치(기본 ad, add) — adde 실행 파일 옆에

옵션:
  -v, --version            버전 출력
  -h, --help               도움말 출력

명령별 도움말은 \`{{primary}} <command> --help\`, 레인 옵션은 \`adde lane help\` 참조.`,
    up: `사용법: adde up <proj> [--json]

  --json       기계가독 출력(부팅 리포트: 레인별 상태 + running 수; 미확정 시 null)`,
    down: `사용법: adde down <proj> [--json]

  --json       기계가독 출력({proj, stopped: true})`,
    restart: `사용법: adde restart <proj> [--json]

  --json       기계가독 출력(부팅 리포트: 레인별 상태 + running 수; 미확정 시 null)`,
    status: "사용법: adde status [<proj>] [--all] [--json]",
    doctor: `사용법: adde doctor [<proj>] [--json]

환경·설정 정적 점검(상태 비의존).
  --json       기계가독 출력(checks 배열; 요약 줄·업데이트 알림 없음)`,
    logs: `사용법: adde logs <proj> <lane> [N] [--engine] [--daemon] [-f|--follow] [--json]

레인 로그의 최근 N줄(기본 50)을 출력합니다.
  (기본)       레인 transcript(메시지·결정·알림)
  --engine     엔진 stderr 캡처(engine.log) — 엔진 크래시 진단
  --daemon     <proj> launchd 데몬 로그(기동 실패 원인이 여기 쌓임; <lane> 불필요)
  -f, --follow 실시간 추적 — 종료 없이 계속 실행하며 신규 라인을 방출(Ctrl-C 로 정지)
  --json       기계가독 출력({proj, lane, path, exists, lines}; --follow 보다 우선 — 스냅샷만 출력, 실시간 추적 없음)`,
    sessions: `사용법: adde sessions <proj> <lane> [--json]

레인에 기록된 엔진 세션 목록(번호·첫 프롬프트 발췌·마지막 활동·id; 현재 세션 ◀ 표시).
읽기 전용 — 세션 재개·초기화는 CLI 가 아니라 채널에서 합니다(/resume <n> 또는 resume 체크박스).
  --json       기계가독 출력(세션 배열)`,
    completion: `사용법: adde completion <bash|zsh>

셸 자동완성 스크립트를 stdout 으로 출력합니다 — 설치는 하지 않습니다(installer 아님).
왜: adde 명령·프로젝트/레인 이름·옵션 값을 Tab 으로 완성할 수 있게 합니다.
무엇: 셸용 스크립트이며, 셸의 자동완성 디렉터리로 직접 리다이렉트해 넣습니다.
어디에/어떻게 결정 (본인 셸 확인: echo $SHELL):
  bash → adde completion bash > /usr/local/etc/bash_completion.d/adde   (또는 ~/.bashrc 에 'source <(adde completion bash)' 추가)
  zsh  → adde completion zsh  > "\${fpath[1]}/_adde"                     (그 뒤 compinit; ~/.zshrc 에 'autoload -Uz compinit && compinit' 필요)
팁: 'adde init' 이 이 설정을 단계별로 안내합니다.`,
    proj: `사용법:
  adde proj ls [--json]      등록된 프로젝트 목록(레인·실행 수 포함)
  adde proj rm <proj>        프로젝트 삭제 — 모든 레인과 state 를 제거

  --json                     기계가독 출력(proj ls 전용)
  --force                    확인 프롬프트 건너뛰기(비대화형 셸에선 필수; proj rm 전용)`,
    init: "사용법: adde init [<proj>]  (가이드 설정: doctor + 짧은 별칭 + 레인 생성; TTY 전용)",
    alias: `사용법: adde alias [names...]   (기본 이름: ad add)

adde 실행 파일 옆에 짧은 별칭(심링크)을 설치해 \`adde up <proj>\` 대신 \`ad up <proj>\` 로 쓸 수 있게 합니다.
전역 설치에서만 동작(PATH 의 adde 옆 쓰기 가능한 bin 디렉터리 필요)하며, 동명 명령이 이미 있으면 덮어쓰지 않고 건너뜁니다.`,
    laneAdd: "사용법: adde lane add <proj> <lane> [옵션]",
    laneSet: "사용법: adde lane set <proj> <lane> --<field> <value> ...",
    laneLs: "사용법: adde lane ls <proj> [--json]",
    laneShow: "사용법: adde lane show <proj> <lane> [--json]",
    laneRm: "사용법: adde lane rm <proj> <lane>",
    daemon: "사용법: adde __daemon <proj> (내부 명령)",
    lane: `사용법:
  adde lane add <proj> <lane> [옵션]   레인 conf 생성
  adde lane set <proj> <lane> --<field> <value> ...  기존 레인 conf 를 제자리 편집
  adde lane ls <proj> [--json]         레인 목록
  adde lane show <proj> <lane> [--json] 레인 conf 출력
  adde lane rm <proj> <lane> [--purge] [--force] 레인 conf 삭제 (--purge 시 state/queue/out 데이터도 삭제; --force 는 --purge 의 실행중 가드/확인을 생략)

lane add 옵션:
  --source <markdown|telegram>  (기본 markdown)
  --perm-tier <acp|autopass>    (기본 acp — 전 도구 채널 승인 / autopass — denylist 외 자동 허용)
  --cwd <abs-path>              레인 작업 폴더(프로젝트 매핑)
  --engine-args <args>          엔진 프로세스에 전달할 추가 CLI 인자, 공백 분리(예: "--model opus")
                                (시크릿·토큰 금지 — OS 프로세스 목록에 노출됨; 따옴표 포함 값 미지원)
  --allowlist <a,b,c>           자동 허용 도구(게이트 유지, perm_tier=acp 용)
  --denylist <항목,...>         autopass 에서 채널 승인으로 폴백할 도구·패턴
                                (예: "Bash,Write(/etc/*)" · 미지정 시 내장 기본 목록: sudo·rm -rf·git 강제 변경·자격증명 읽기 차단)
  --hard-deny <항목,...>        방어심화: 티어 무관 즉시 거부(프롬프트 없음)할 도구·패턴
  --safe-defaults               hard-deny 에 내장 위험 목록 채우기(sudo·rm -rf·git 강제·자격증명 읽기)
  --lang <en|ko>                이 레인의 채널 메시지 로케일 (기본: 전역 로케일)
  --chat-id <id>                telegram 회신 대상(해당 chat 인바운드도 허용)
  --allow-from <ids>            추가 허용 인바운드 발신자 id(콤마 구분 user/chat id)
  --file-mode <private|shared>  state/out/queue 디렉터리 권한(기본 private=0700 소유자 전용; shared=umask 기본 유지, 통상 타 사용자 열람 가능)
  --token-stdin                 telegram 봇 토큰을 stdin 에서 읽어 .env(0600) 기록
  --root <abs-path>             markdown 루트(예: Obsidian vault)
  --inbox <rel> --approvals <rel> --outbox <rel>   markdown 노트 경로
  --force                       기존 conf 덮어쓰기
  --interactive                 대화형 위저드 강제(TTY 에서 기본; 봇 토큰은 가려진 입력)
  --no-interactive              대화형 기본을 끄고 플래그/기본값 사용(스크립트용)

lane set 옵션(lane add 의 편집 전용 부분집합 — 정체성 필드·토큰·safe-defaults 는 편집 불가, 대신 레인을 재생성하세요):
  --perm-tier <acp|autopass>
  --allowlist <a,b,c>           전체 치환(병합 아님)
  --denylist <항목,...>         전체 치환(병합 아님)
  --hard-deny <항목,...>        전체 치환(병합 아님; 기존 값이 있었으면 경고)
  --cwd <abs-path>
  --engine-args <args>
  --lang <en|ko>
  --file-mode <private|shared>
  --chat-id <id>                telegram 레인 전용
  --allow-from <ids>            telegram 레인 전용
  --root <abs-path>              markdown 레인 전용
  --inbox <rel> --approvals <rel> --outbox <rel>   markdown 레인 전용
지정하지 않은 필드는 기존 값을 유지합니다. 변경은 adde restart <proj> 이후 반영됩니다.
참고: --file-mode 편집은 conf 값만 갱신하며, 재시작 후에도 기존 디렉터리 권한은 변경되지 않습니다(private→shared 완화는 수동 chmod 필요). file_mode 는 내부 state/out/queue 디렉터리만 지배하며 마크다운 노트 트리는 대상이 아닙니다.`,
  },
  cli: {
    cmdError: "[adde {{cmd}}] 오류: {{detail}}",
    laneError: "[adde lane] {{detail}}",
    unknownSub: "알 수 없는 lane 서브커맨드: {{sub}}",
    unknownCmd: "알 수 없는 명령: {{cmd}}",
    didYouMean: "이것을 찾으셨나요: {{cmds}}?",
    unknownFlag: "알 수 없는 옵션: {{flag}}",
    valueRequired: "{{key}} 에 값이 필요합니다",
  },
  completion: {
    unknownShell: '미지원 셸 "{{shell}}" — {{supported}} 중 하나',
    installHint:
      "↳ 이것은 자동완성 스크립트 출력이며 installer 가 아닙니다. 사용하려면 {{shell}} 자동완성 디렉터리로 리다이렉트하세요(스크립트 상단 주석 참조). 정확한 경로는 'adde completion {{shell}} --help'.",
  },
  run: {
    laneStartFailed: {
      situation: '레인 "{{lane}}" 기동 실패: {{error}}',
      action:
        "adde doctor {{proj}} 로 환경·설정을 점검하고, adde logs {{proj}} {{lane}} --engine 으로 엔진 출력을 확인하세요.",
    },
    unknownCause: "원인 미상",
    noLanes: {
      situation: "기동할 레인이 없습니다 — {{proj}} 에 레인 설정(conf)이 없습니다",
      action:
        "adde lane add {{proj}} <lane> --source markdown (또는 telegram) 으로 레인을 먼저 만드세요. 옵션은 adde lane help.",
    },
    signalShutdown: "[adde] {{sig}} 수신 — 레인 종료 중...",
    shutdownError: {
      situation: "종료 처리 중 오류: {{error}}",
      action: "잔존 엔진 프로세스를 수동 확인/종료하세요(ps | grep claude-agent-acp).",
    },
    upDone: "[adde] {{proj}} 데몬 등록 완료. 백그라운드에서 레인이 기동됩니다.",
    alreadyUp:
      "[adde] {{proj}} 는 이미 기동 중입니다 — 레인 {{running}}/{{total}} 실행 중. 새로 기동할 것이 없습니다.",
    alreadyUpHint:
      "  확인: adde status {{proj}} · 설정 변경 반영: adde restart {{proj}} · 종료: adde down {{proj}}",
    alreadyUpUnhealthy:
      "[adde] {{proj}} 에 비정상 레인이 있습니다: {{lanes}}\n  ↳ 조치: adde status {{proj}} / adde logs {{proj}} --daemon 으로 확인 후 adde restart {{proj}}.",
    deadRegistered:
      "[adde] {{proj}} 는 등록되어 있으나 상주 중인 레인이 없습니다(데몬이 죽음) — 재적재합니다...",
    upFailed:
      "[adde] 기동 실패 레인: {{lanes}}\n  ↳ 조치: adde logs {{proj}} <lane> --engine 또는 데몬 로그 adde logs {{proj}} --daemon 으로 확인 후 adde restart {{proj}}.",
    upSummary: "  실행 중 {{running}} · 실패 {{failed}}",
    upInconclusive:
      "[adde] 대기 시간 내에 기동된 레인이 없습니다 — 데몬이 부팅에 실패했을 수 있습니다.\n  ↳ 조치: adde logs {{proj}} --daemon 으로 데몬 로그를 확인한 뒤 adde restart {{proj}}.",
    pollMsDeprecated:
      "[adde] ADDE_UP_POLL_MS 는 더 이상 해석되지 않습니다 — ADDE_UP_WAIT_MS 로 이관하세요(미설정 시 기본 8000ms 는 그대로 유지).",
    statusHint: "  상태 확인: adde status {{proj}}",
    downDone: "[adde] {{proj}} 데몬 종료 완료.",
    restartDone: "[adde] {{proj}} 재기동 완료. 백그라운드에서 레인이 기동됩니다.",
  },
  ops: {
    status: {
      noLanesConf: "레인 없음 — lanes.d 에 conf 가 없습니다 (adde lane add <proj> <lane>).",
      noLanesRegistered: "레인 없음 — 등록된 레인이 없습니다 (adde lane add <proj> <lane>).",
      noRunning:
        "실행 중인 레인 없음 — 정지 포함 전체는 `adde status --all`, 특정 프로젝트는 `adde status <proj>`.",
      deadWarnAggregate:
        "경고: {{lanes}} 레인이 비정상 종료(dead)했습니다.\n  ↳ 조치: adde down <proj> 로 정리한 뒤 adde up <proj> 로 재기동하세요.",
      staleWarnAggregate:
        "경고: {{lanes}} 레인이 응답 없음(stale — 하트비트 끊김).\n  ↳ 조치: adde logs <proj> <lane> --engine 으로 진단 후 adde down/up <proj> 로 재기동하세요.",
      deadWarnSingle:
        "경고: {{lanes}} 레인이 비정상 종료(dead)했습니다.\n  ↳ 조치: adde down {{proj}} 로 상태를 정리한 뒤 adde up {{proj}} 로 재기동하세요.",
      staleWarnSingle:
        "경고: {{lanes}} 레인이 응답 없음(stale — 프로세스는 살아있으나 하트비트 끊김).\n  ↳ 조치: 행(hang) 가능성. adde logs {{proj}} <lane> --engine 으로 진단 후 adde down/up {{proj}} 로 재기동하세요.",
      errorWarnAggregate:
        "오류: 기동 실패 레인: {{lanes}}.\n  ↳ 조치: 데몬 로그(adde logs <proj> --daemon) 또는 엔진 로그(adde logs <proj> <lane> --engine) 확인 후 adde restart <proj>.",
      errorWarnSingle:
        "오류: 기동 실패 레인: {{lanes}}.\n  ↳ 조치: 데몬 로그(adde logs {{proj}} --daemon) 또는 엔진 로그(adde logs {{proj}} <lane> --engine) 확인 후 adde restart {{proj}}.",
      haltWarn:
        "[adde] {{proj}} 가 반복된 크래시루프 재기동 후 자가 정지했습니다.\n  ↳ 조치: 원인을 수정한 뒤 adde restart {{proj}}.",
    },
    doctor: {
      hint: "    ↳ 조치: {{hint}}",
      summary: "요약: {{pass}} PASS / {{warn}} WARN / {{fail}} FAIL / {{info}} INFO",
    },
    logs: {
      whatEngine: "engine 로그",
      whatTranscript: "transcript",
      badCount:
        '줄수 "{{raw}}" 는 유효하지 않습니다(양의 정수만 가능) — 기본값 50 으로 대체합니다.',
      watchError: "경고: 로그 변경 감시 실패({{msg}}) — 1초 폴링으로 계속 추적합니다.",
      notFound:
        "{{what}} 없음: {{path}}\n  ↳ 조치: 레인이 아직 활동하지 않았거나 기동되지 않았습니다. adde status {{proj}} 로 상태를 확인하세요.",
      daemonNotFound:
        "데몬 로그 없음: {{path}}\n  ↳ 조치: {{proj}} 데몬이 아직 실행되지 않았거나(또는 출력이 없음). adde up {{proj}} 로 기동하세요.",
      empty: "({{path}} 비어있음)",
    },
  },
  lane: {
    retry: {
      chatId: "  chat_id — 숫자 id 를 입력하세요(없으면 비움)",
      allowFrom: "  allow_from — 콤마 구분 숫자 id 를 입력하세요(없으면 비움)",
    },
    prompt: {
      source: "source (번호 또는 값 입력)",
      permTier: "perm_tier (acp = 도구마다 채널 승인 / autopass = denylist 외 자동 허용)",
      allowlist: "allowlist (콤마 구분, 없으면 비움)",
      denylist: "denylist (채널 승인으로 폴백할 도구·패턴, 콤마 구분)",
      safeDefaults:
        "방어심화 하드-거부 기본값을 켤까요? sudo / rm -rf / git 강제 / 자격증명 읽기를 즉시 차단 (y/N)",
      lang: "lang (채널 메시지 로케일, 전역은 비움)",
      token: "telegram 봇 토큰 (가려진 입력, 나중에 설정하려면 비움)",
      cwd: "cwd (레인 작업 폴더 절대경로, 없으면 비움)",
      engineArgs:
        "engine_args (엔진 프로세스에 전달할 추가 CLI 인자, 공백 분리, 없으면 비움 — 시크릿은 넣지 마세요: OS 프로세스 목록에 노출됩니다)",
      chatId: "chat_id (회신 대상 + 해당 chat 인바운드 허용, 없으면 비움)",
      allowFrom: "allow_from (추가 허용 발신자 id, 콤마 구분, 없으면 비움)",
      fileMode:
        "file_mode (private=소유자 전용 0700 / shared=umask 기본 유지, 통상 타 사용자 열람)",
      root: "root (markdown 루트 절대경로)",
      inbox: "inbox (root 상대)",
      approvals: "approvals (root 상대, 없으면 기본)",
      outbox: "outbox (root 상대, 없으면 기본)",
    },
    ttyOnly: {
      situation: "--interactive 는 대화형 터미널(TTY)에서만 동작합니다",
      action:
        "플래그로 지정하세요(예: adde lane add <proj> <lane> --source markdown). 옵션 목록은 adde lane help.",
    },
    created: '레인 "{{lane}}" 생성: {{confPath}}',
    set: {
      updated: '레인 "{{lane}}" 갱신: {{confPath}}',
      restartHint: "변경 사항은 adde restart {{proj}} 이후 반영됩니다",
    },
    noLanes: "{{proj}}: 레인 없음",
    removed: '레인 "{{lane}}" 삭제: {{confPath}}',
    removedPurged: '레인 "{{lane}}" 삭제 + state/queue/out 정리: {{confPath}}',
    purgeRunning:
      '레인 "{{lane}}" 은 안전하게 정리할 수 없습니다(실행 중이거나, 데몬이 살아있는 채로 기동 실패) — --purge 전에 먼저 데몬을 내리거나(adde down {{proj}}) --force 로 강제 정리하세요.',
    purgeNeedForce:
      "확인 없이 --purge 를 거부합니다(봇 토큰 포함 state 삭제) — 터미널에서 확인하거나 --force 를 주세요.",
    purgeConfirm: '--purge 를 확인하려면 레인 이름 "{{lane}}" 을 입력하세요(state/queue/out 삭제)',
    purgeAborted: "취소됨 — 이름이 일치하지 않습니다.",
    tokenWritten: "토큰 기록: {{envPath}} (0600)",
    tokenNext: "다음: 봇 토큰을 {{envPath}} 에 TELEGRAM_BOT_TOKEN=... 으로 두세요",
    startHint: "기동: adde up {{proj}}",
  },
  proj: {
    none: "등록된 프로젝트 없음 (adde lane add <proj> <lane> 로 생성).",
    removed: '프로젝트 "{{proj}}" 삭제됨: {{path}}',
    notFound: '프로젝트 "{{proj}}" 없음 ({{path}})',
    running:
      '프로젝트 "{{proj}}" 에 활성 레인이 있습니다: {{lanes}} — 먼저 데몬을 내리세요(adde down {{proj}}), 또는 --force 로 강제 삭제.',
    needForce:
      "확인 없이 삭제를 거부합니다 — 터미널에서 실행해 대화형으로 확인하거나 --force 를 주세요.",
    confirmPrompt:
      '삭제를 확인하려면 프로젝트 이름 "{{proj}}" 을 입력하세요(모든 레인과 state 제거)',
    aborted: "취소됨 — 이름이 일치하지 않습니다.",
  },
  doctor: {
    node: {
      name: "Node 버전",
      hint: "Node 22 이상으로 업그레이드하세요(nvm install 22 등).",
    },
    adapter: {
      name: "ACP 어댑터 바이너리",
      missing: "해석된 경로에 파일 없음: {{path}}",
      hint: "의존성을 설치하세요(pnpm install) — @agentclientprotocol/claude-agent-acp 누락.",
    },
    daemonEntry: {
      name: "데몬 진입 파일",
      missing: "데몬 진입 파일을 찾을 수 없음: {{path}}",
      hint: "데몬 모드는 빌드가 필요합니다. `pnpm build` 후 dist 로 실행(`node dist/cli/adde.js up <proj>`)하거나 전역 설치(`npm i -g .`)하세요. `pnpm run dev up` 으로는 데몬을 띄울 수 없습니다.",
    },
    base: {
      name: "설정 base 디렉터리",
      hint: "레인을 추가하면 생성됩니다(adde lane add <proj> <lane>).",
    },
    missingPath: "없음: {{path}}",
    daemon: {
      name: "daemon 등록 ({{proj}})",
      registered: "plist 존재 + launchctl 등록 완료",
      notRunning: "데몬 미기동 상태 (adde up {{proj}} 으로 기동 가능)",
      plistOnly: "plist 존재하나 launchctl 미등록",
      launchctlOnly: "launchctl 등록되어 있으나 plist 없음",
      mismatchHint:
        "등록 불일치 상태입니다. adde down {{proj}} 후 adde up {{proj}} 으로 재등록하세요.",
      queryFailed: "등록 상태 조회 실패",
      queryFailedHint:
        "adde down {{proj}} 후 adde up {{proj}} 으로 재등록하거나, launchctl list | grep com.qwertygeon.adde.{{proj}} 로 수동 확인하세요.",
    },
    lanes: {
      name: "레인 ({{proj}})",
      none: "lanes.d 에 conf 없음",
      addHint: "레인을 추가하세요: adde lane add {{proj}} <lane>",
    },
    conf: {
      readFailed: "읽기 실패: {{path}}",
      readFailedHint: "conf 파일 권한/존재를 확인하세요.",
    },
    source: {
      unsupported: '미지원 source: "{{source}}"',
      hint: "conf 의 source 를 markdown 또는 telegram 으로 설정하세요.",
    },
    legacyKeys: {
      detail: "구 평면 어댑터 키 감지: {{keys}} (무시됨)",
      hint: "conf 포맷이 네임스페이스 키로 변경됐습니다 — markdown.root/markdown.inbox, telegram.chat_id/telegram.allow_from 를 쓰세요. 레인을 재생성(adde lane add)하거나 키 이름을 바꾸세요.",
    },
    cwd: {
      hint: "conf 의 cwd 를 존재하는 작업 폴더로 수정하세요.",
    },
    token: {
      name: "{{lane}}: 토큰",
      present: ".env 에 TELEGRAM_BOT_TOKEN 존재",
      missing: "토큰 없음: {{path}}",
      hint: "봇 토큰을 기록하세요: {{path}} 에 TELEGRAM_BOT_TOKEN=... (또는 lane add --token-stdin).",
    },
    markdown: {
      name: "{{lane}}: 마크다운 경로",
      ok: "root/inbox 설정됨",
      rootMissing: "markdown 레인에 root 가 없습니다 — 레인 기동에 실패합니다",
      rootMissingHint: "conf 에 root 를 설정하세요 (lane add --root <vault 절대경로>).",
      rootNotFound: "markdown root 경로가 없습니다: {{path}}",
      rootNotFoundHint: "경로를 생성하거나 conf 의 root 를 고치세요.",
      inboxMissing: "markdown 레인에 inbox 노트가 없습니다 — 레인 기동에 실패합니다",
      inboxMissingHint: "conf 에 inbox 를 설정하세요 (lane add --inbox <root 상대 노트경로>).",
    },
    perms: {
      name: "{{lane}}: 파일 권한",
      ok: "state 디렉터리/.env 권한이 제한적입니다",
      envLoose: "state/.env 가 그룹/기타에서 접근 가능(mode {{mode}}) — 봇 토큰 노출 위험",
      envHint: "권한을 제한하세요: chmod 600 {{path}}",
      stateLoose:
        "state 디렉터리가 그룹/기타에서 접근 가능(mode {{mode}}) — file_mode=private 는 0700 을 기대합니다",
      stateHint:
        "권한을 제한하세요: chmod 700 {{path}} — 또는 레인을 재시작(adde restart {{proj}})하면 다시 잠급니다.",
      sharedTight:
        "state 디렉터리가 그룹/기타에 열려있지 않으나(mode {{mode}}) file_mode=shared 로 선언됨 — 권한이 완화되지 않았습니다(fail-closed)",
      sharedTightHint:
        "안전합니다(선언보다 조여짐). file_mode 편집은 기존 디렉터리를 완화하지 않습니다 — 실제로 완화하려면 state/out/queue 디렉터리를 수동 chmod 하세요: {{path}}",
    },
    halt: {
      name: "자가 정지 ({{proj}})",
      detail: "연속 {{count}}회 짧은-수명 크래시 후 자가 정지됨 — {{reason}}",
      hint: "원인을 수정한 뒤 adde restart {{proj}} 로 재시도하세요.",
    },
    deadReg: {
      name: "데몬 생존 ({{proj}})",
      detail:
        "launchctl 에 등록되어 있으나 상주 레인이 없습니다 — auto_restart=off 라면 크래시 후 예상된 상태(자동 재기동 없음)이고, 아니면 데몬이 부팅에 실패했을 수 있습니다",
      hint: "adde logs {{proj}} --daemon 으로 원인을 확인한 뒤 adde restart {{proj}}.",
    },
  },
  update: {
    available:
      "adde 새 버전이 있습니다: {{current}} → {{latest}}. `npm i -g adde-acp@latest` 로 업데이트하세요(이후 `adde restart <proj>`).",
  },
  gate: {
    hardDeny:
      "⛔ 하드-거부로 차단됨: {{tool}} — 이 도구는 레인 hard_deny 목록에 있어 승인 프롬프트 없이 거부되었습니다.",
  },
  init: {
    ttyOnly: {
      situation: "adde init 는 대화형 터미널(TTY)이 필요합니다",
      action:
        "터미널에서 실행하거나 수동 설정: adde doctor / adde lane add <proj> <lane> --interactive / adde alias.",
    },
    intro: "adde 설정 — 환경 점검, 짧은 별칭, 첫 레인을 만듭니다.",
    doctorWarn:
      "위에 FAIL 항목이 있습니다. 계속 진행할 수 있으나 데몬 기동(adde up) 전에 해결하세요.",
    aliasPrompt: "짧은 별칭({{names}})을 adde 명령 옆에 설치할까요? (Y/n)",
    completionPrompt: "{{shell}} 셸 탭 자동완성을 지금 설정할까요? (실행할 명령을 출력) (Y/n)",
    completionWhat: "  탭 자동완성으로 adde 명령·프로젝트/레인 이름·옵션 값을 완성할 수 있습니다.",
    completionBash:
      "  실행: adde completion bash > /usr/local/etc/bash_completion.d/adde   (또는 ~/.bashrc 에 'source <(adde completion bash)' 추가 후 새 셸)",
    completionZsh:
      "  실행: adde completion zsh > \"${fpath[1]}/_adde\"   (~/.zshrc 에 'autoload -Uz compinit && compinit' 확인 후 새 셸)",
    aliasNoBin:
      "PATH 에서 adde 명령을 찾지 못했습니다 — 별칭 설치를 건너뜁니다(전역 설치에서만 가능).",
    aliasCreated: "  ✔ 별칭 생성: {{name}} → {{dir}}",
    aliasAlready: "  = 별칭이 이미 adde 를 가리킴: {{name}}",
    aliasSkipped: "  ✘ {{name}} 건너뜀 — 동명 명령이 PATH 에 이미 존재합니다",
    aliasFailed: "  ✘ 별칭 {{name}} 생성 실패 — {{detail}}",
    projPrompt: "프로젝트 이름",
    projRetry: "프로젝트 이름 (영숫자/_/- 만)",
    lanePrompt: "레인 이름",
    laneRetry: "레인 이름 (영숫자/_/- 만)",
    done: "프로젝트 '{{proj}}' 설정 완료.",
  },
  laneConfig: {
    warn: {
      cwdMissing:
        "[경고] cwd 경로가 없습니다: {{path}}\n  ↳ 조치: 기동 전 폴더를 만들거나 conf 의 cwd 를 수정하세요.",
      mdRootMissingConf:
        "[경고] markdown 레인에 root 가 없습니다.\n  ↳ 조치: --root <vault 절대경로> 를 지정하세요(없으면 인바운드 감시 불가).",
      mdRootNotFound:
        "[경고] markdown root 경로가 없습니다: {{path}}\n  ↳ 조치: 경로를 확인하거나 생성하세요.",
      mdPathOverlap:
        "[경고] markdown 경로가 겹칩니다(inbox={{inbox}} / approvals={{approvals}} / outbox={{outbox}}) — 기동이 거부됩니다.\n  ↳ 조치: 승인·출력·입력 경로를 서로 분리하세요.",
      tokenFormat:
        "[경고] 봇 토큰 형식이 예상과 다릅니다(<숫자>:<영숫자> 아님).\n  ↳ 조치: BotFather 발급 토큰을 다시 확인하세요.",
      tokenOverwritten:
        "[경고] --force 로 {{envFile}} 의 기존 봇 토큰을 덮어썼습니다 — 이전 토큰은 사라졌습니다.",
      permTierUnknown:
        '[경고] perm_tier "{{tier}}" 는 알려진 값({{known}})이 아닙니다 — acp 처럼 동작합니다.\n  ↳ 조치: 오타라면 conf 의 perm_tier 를 수정하세요.',
      autopassBanner:
        "[경고] perm_tier=autopass — denylist 외 모든 도구(파일 쓰기·Bash 실행 포함)가 채널 확인 없이 자동 허용됩니다.\n  ↳ 확인이 필요한 도구는 denylist 에 두세요(예: denylist=Bash). 자동 허용 내역은 transcript 에 기록됩니다.",
      autopassEmptyDeny:
        "[경고] autopass 레인에 denylist 가 비어 있습니다 — 모든 권한 요청이 무확인 통과됩니다.",
      allowDenyOverlap:
        "[경고] allowlist 와 denylist 에 같은 도구가 있습니다: {{tools}} — denylist 가 우선하여 채널 승인을 거칩니다.\n  ↳ 조치: 의도가 아니라면 한쪽에서 제거하세요.",
      badLang:
        '[경고] lang "{{lang}}" 은 지원 로케일({{supported}})이 아닙니다 — 전역 로케일이 적용됩니다.\n  ↳ 조치: 오타라면 conf 의 lang 을 수정하세요.',
      telegramNoAuth:
        "[경고] telegram 레인에 허용 인바운드 발신자가 없습니다 — 모든 인바운드가 거부됩니다(fail-closed). 개인 chat_id 는 자기 인증되지만, 그룹 chat_id(음수)는 회신 대상일 뿐 멤버를 인증하지 않습니다.\n  ↳ 조치: --chat-id <본인 개인 chat id> 설정, 및/또는 --allow-from <id들> 로 멤버 id 를 지정하세요.",
      mdBackupNoArchive:
        "[경고] backup 이 활성화되어 있으나 archive 가 설정되지 않았습니다 — inbox 내용이 계속 쌓입니다.\n  ↳ 조치: markdown.archive 를 설정해 전송 본문도 함께 이관하세요.",
      hardDenyReplaced:
        "[경고] hard_deny 가 치환되었습니다 — 기존 목록은 사라졌습니다(lane set 은 기존 목록과 병합하지 않고 전체 치환합니다).",
      fileModeRelaxNotice:
        "[경고] file_mode 를 shared 로 바꿨으나 기존 디렉터리 권한(0700)은 adde restart 후에도 유지됩니다.\n  ↳ 조치: 완화하려면 레인의 state/out/queue 디렉터리를 수동으로 chmod 하세요(file_mode 는 이 내부 디렉터리만 지배하며 마크다운 노트 트리는 대상이 아닙니다).",
    },
    err: {
      emptyIdent: "{{kind}} 가 비어있습니다",
      badIdent: '{{kind}} "{{value}}" 가 올바르지 않습니다 — 영문/숫자/_/- 만 허용',
      badSource: 'source "{{source}}" 미지원 — {{supported}} 중 하나',
      unknownEngine: 'engine "{{value}}" 미지원 — {{known}} 중 하나',
      unknownBackend: 'backend "{{value}}" 미지원 — {{known}} 중 하나',
      invalidEngineArgs: "engine_args 가 올바르지 않습니다: {{reason}}",
      badChatId: 'chat_id "{{chatId}}" 가 숫자가 아닙니다',
      tokenOnlyTelegram: "token 은 source=telegram 레인에서만 사용합니다",
      allowFromOnlyTelegram: "allow_from 은 source=telegram 레인에서만 사용합니다",
      badAllowFrom: 'allow_from 항목 "{{id}}" 가 숫자가 아닙니다(telegram user/chat id)',
      badFileMode: 'file_mode "{{mode}}" 가 올바르지 않습니다 — {{known}} 중 하나',
      badAllowTool: 'allowlist 도구명 "{{tool}}" 가 올바르지 않습니다 — 영숫자/_/./- 만 허용',
      badDenyEntry:
        'denylist 항목 "{{entry}}" 가 올바르지 않습니다 — "Bash" 또는 "Bash(git push*)" 형식(콤마 불가)',
      laneExists: '레인 "{{lane}}" 이 이미 존재합니다 ({{confFile}}) — 덮어쓰려면 --force',
      tokenEmpty: "token 이 비어있습니다",
      envHasToken: "{{envFile}} 에 이미 토큰이 있습니다 — 덮어쓰려면 --force",
      laneNotFound: '레인 "{{lane}}" 을 찾을 수 없습니다 ({{confFile}})',
      identityFieldImmutable:
        "{{field}} 는 lane set 으로 변경할 수 없습니다 — 변경하려면 레인을 재생성하세요(adde lane rm 후 adde lane add).",
      sourceFieldMismatch: "{{field}} 는 source={{source}} 레인에는 적용되지 않습니다",
      noEdits: "편집 플래그가 없습니다 — 변경할 내용이 없습니다",
    },
  },
  telegram: {
    permPrompt: "권한 요청: {{tool}}\n{{detail}}",
    enqueueFail: {
      situation: "수신 메시지 큐 적재(enqueue)가 연속 {{count}}회 실패했습니다",
      action:
        "서버 디스크 용량과 state 디렉터리 권한을 확인하세요. 해소되기 전까지 수신 메시지가 처리되지 않을 수 있습니다.",
    },
  },
  markdown: {
    enqueueFail: {
      situation: "수신 메시지 큐 적재(enqueue)가 연속 {{count}}회 실패했습니다",
      action:
        "서버 디스크 용량과 state 디렉터리 권한을 확인하세요. 해소 전까지 인박스 지시가 처리되지 않을 수 있습니다.",
    },
    confRootMissing: "[markdown] conf.root 누락 — 마크다운 루트 절대경로 필수",
    confInboxMissing: "[markdown] conf.inbox 누락 — 입력 노트(root 상대) 필수",
    rootNotFound: "[markdown] root 경로 없음: {{path}}",
    pathNotRelative: "[markdown] {{name}} 경로는 root 상대여야 하며 '..'·절대경로 금지: {{rel}}",
    controlNoteInCwd:
      "[markdown] 제어 노트({{name}})가 AI 작업폴더 내부에 있음: {{path}} (cwd={{cwd}}) — 자기승인 위험, cwd 밖으로 분리 필요",
    pathsOverlap:
      "[markdown] {{nameA}}({{a}})와 {{nameB}}({{b}})가 같거나 포함 관계 — 출력·알림·격리 노트가 승인/입력 감시에 잡힙니다. 경로를 분리하세요.",
    inboxInsideDir:
      "[markdown] 입력 노트({{inbox}})가 {{name}} 디렉터리({{dir}}) 내부 — 입력/제어 경로가 겹칩니다. 경로를 분리하세요.",
    badApprovalId: '잘못된 승인 요청 id "{{reqId}}" — 경로 탈출 차단(fail-closed deny).',
    outMeta: "🕒 요청 {{sent}} · 완료 {{done}}",
    approvalMeta: "🕒 요청 {{requested}} · 무응답 시 {{deadline}} 자동 거부",
    backupPathOverlap:
      "[markdown] 백업 경로가 {{name}}({{path}})와 겹칩니다: {{backup}} — vault/state 손상 위험으로 기동을 거부합니다.",
    syncProviderUnsupported: '[markdown] 미지원 sync_provider "{{value}}" — 지원값: {{supported}}',
    outRetentionTooLow:
      "[markdown] out_retention_days({{outRetentionDays}}) 는 retention_days({{retentionDays}}) + {{margin}} 이상이어야 합니다 — 기동을 거부합니다.",
    backupNoArchiveWarn:
      "⚠️ 백업 이관은 켜져 있으나 archive 가 설정되지 않았습니다 — inbox 내용이 계속 쌓입니다(전송 본문이 이관되지 않음). markdown.archive 를 설정하면 아카이브도 이관됩니다.",
  },
  supervisor: {
    noLanesMsg: "{{proj}}: 레인 0개 — lanes.d 에 conf 없음",
    alreadyRunning:
      '[adde] 레인 "{{lane}}" 이미 실행 중 (pid {{pid}})\n  ↳ 조치: adde down {{proj}} 후 재기동 또는 adde status {{proj}} 확인',
    autopassDenySome: "denylist({{tools}}) 도구만 채널 승인을 거칩니다",
    autopassDenyEmpty: "denylist 가 비어 있어 모든 권한 요청이 확인 없이 통과됩니다",
    autopassBanner: {
      situation:
        "이 레인은 자동 허용 모드(perm_tier=autopass)로 기동했습니다 — {{denyDesc}}. 그 외 도구(파일 쓰기·Bash 실행 포함)는 자동 허용됩니다",
      action:
        "확인이 필요한 도구는 lanes.d/{{lane}}.conf 의 denylist 에 추가하세요. 자동 허용 내역은 adde logs {{proj}} {{lane}} 으로 확인할 수 있습니다.",
    },
    upStarted: "{{proj}}: {{count}}개 레인 기동",
    upSkipped: "{{count}}개 이미 실행 중(스킵)",
    downStopped: "{{proj}}: {{count}}개 레인 종료",
    source: {
      unknown:
        '알 수 없는 소스 "{{source}}" — 등록되지 않은 소스입니다. lanes.d/<lane>.conf 의 source= 를 수정하세요(지원 소스는 adde doctor 참조).',
    },
    engineWiring: {
      unknownEngine:
        '미지원 engine "{{value}}"(알려진 값: {{known}}) — lanes.d/<lane>.conf 의 engine= 을 수정하세요.',
      unknownBackend:
        '미지원 backend "{{value}}"(알려진 값: {{known}}) — lanes.d/<lane>.conf 의 backend= 을 수정하세요.',
    },
    engineArgs: {
      parseFail:
        "engine_args 파싱 실패: {{detail}} — 따옴표 포함 값은 지원하지 않습니다(공백 분리만 가능). lanes.d/<lane>.conf 의 engine_args= 를 수정하세요.",
    },
    selfRecovery: {
      attempt: "⚠️ 레인 {{lane}} 엔진이 크래시됐습니다 — 자가 회복(백오프) 시도 중…",
      abandoned:
        "🛑 레인 {{lane}} 자가 회복이 {{attempts}}회 시도 후 포기했습니다 — 상태를 error 로 표기합니다. adde restart {{proj}} 로 복구하세요.",
      disabled:
        "🛑 레인 {{lane}} 엔진이 크래시됐습니다 — auto-relaunch 가 꺼져 있어(auto_relaunch=false) 재기동을 시도하지 않고 상태를 error 로 표기합니다. adde restart {{proj}} 로 복구하세요.",
    },
  },
  launchd: {
    macOnly: {
      situation: "launchd 기능은 macOS 에서만 동작합니다 (현재 플랫폼: {{platform}})",
      action: "macOS 에서 실행하세요. Linux/WSL 지원은 추후 spec 범위.",
    },
    loadFail: {
      situation: "launchctl load 실패 (exit {{code}}): {{output}}",
      action:
        "adde doctor {{proj}} 로 등록 상태를 점검하거나, 기존 등록을 먼저 해제하세요 (adde down {{proj}}).",
    },
    binMissing: {
      situation: "데몬 실행 파일을 찾을 수 없습니다: {{path}}",
      action:
        "데몬 모드는 빌드가 필요합니다 — `pnpm build` 후 dist 로 실행(`node dist/cli/adde.js up <proj>`)하거나 전역 설치(`npm i -g .`) 후 `adde up <proj>` 하세요. `pnpm run dev up` 으로는 데몬을 띄울 수 없습니다(launchd 가 분리 프로세스를 스폰하므로 tsx 트랜스파일이 적용되지 않습니다).",
    },
  },
  queue: {
    claimFail: {
      situation: "큐 메시지 claim 실패({{code}}): {{path}}",
      action:
        "디스크 용량·파일 권한·마운트(NFS/EBUSY)를 확인하세요. 메시지는 큐에 남아 다음 신호에 재시도됩니다.",
    },
    quarantined: "손상 메시지 격리 @ {{ts}}: {{detail}}",
  },
  outLedger: {
    readFail: {
      situation: "out-상태 ledger 읽기 실패({{path}}): {{error}}",
      action:
        "디스크/권한 문제를 확인하세요. 이번 호출은 빈 ledger 로 처리됩니다(보수적 — 파일이 복구되기 전까지 비멱등 레인은 미전송 메시지를 재전송하지 않습니다).",
    },
    corrupt: {
      situation: "out-상태 ledger 파싱 실패({{path}}): {{error}}",
      action:
        "파일이 외부 원인(디스크 오류·수동 편집·동기화 충돌)으로 손상됐을 수 있습니다. 이번 호출은 빈 ledger 로 처리됩니다(비멱등 레인의 in-flight 응답이 재전송되지 않을 수 있음 — 무중복 방향). 가능하면 백업에서 복원하세요.",
    },
    unknownVersion: {
      situation: "out-상태 ledger 스키마 버전 인식 불가({{path}}, v={{v}})",
      action:
        "더 최신 ADDE 버전에서 생성된 파일일 수 있습니다. 알려진 필드만 best-effort 로 읽습니다 — 다운그레이드 후 동작을 확인하세요.",
    },
  },
  injector: {
    injectFailed: "inject 실패 @ {{ts}}: {{detail}}",
    control: {
      cleared: "🧹 새 세션을 시작했습니다 — 이전 대화 맥락은 비워졌습니다.",
      compacted: "✂️ 대화 컨텍스트를 압축했습니다(/compact).",
      resumed: "⏪ 세션 {{id}} 를 재개했습니다.",
      resumeFallback: "⚠️ 세션 {{id}} 복귀에 실패해 새 세션으로 시작했습니다.",
      resumeMissing: "⚠️ 재개할 세션 id 가 없습니다 — 목록에서 선택해 주세요.",
      unsupported: "⚠️ 이 백엔드는 세션 제어를 지원하지 않습니다.",
      relaunchFailed:
        "🛑 세션 제어 실패 — 엔진 재기동 오류: {{error}}. 레인이 중단됐을 수 있습니다 — `adde restart <proj>` 로 복구하세요.",
      sessionsHeader: "📋 최근 세션 목록 (현재 세션 ◀):",
      sessionsItem: "{{n}}. {{label}} — 마지막 대화 {{last}} ({{id}})",
      sessionsNoLabel: "(프롬프트 없음)",
      sessionsEmpty: "📋 기록된 세션이 아직 없습니다.",
      sessionsHint: "재개: 체크박스 라벨 `resume <번호>` 또는 `/resume <번호>`.",
    },
    failNote: {
      situation: "메시지 처리 실패 — id {{id}}: {{detail}}",
      action: "메시지는 보존되어 재기동 시 재처리됩니다. 반복되면 트랜스크립트·로그를 확인하세요.",
    },
    deliverUncertain:
      "⚠️ 전송 중 프로세스가 중단됐습니다 — 이 응답(id {{id}})의 전달 여부가 불확실합니다. 중복 방지를 위해 재전송하지 않습니다. 도착하지 않았다면 다시 요청해 주세요.",
  },
  transcript: {
    commandsUpdated: "[{{ts}}] commands_update: (갱신)",
  },
  acp: {
    spawnFail: {
      situation: "엔진 프로세스 spawn 실패 ({{bin}}): {{error}}",
      action: "어댑터 바이너리 설치를 확인하세요(pnpm install) 후 adde up 재시도.",
    },
    handshakeTimeout: {
      situation: "엔진 핸드셰이크({{phase}}) {{seconds}}초 내 무응답",
      action: "엔진 바이너리·헬스를 확인하세요 후 adde up 재시도.",
    },
    subscriberError: "구독자 처리 오류: {{error}}",
    bypassAction:
      "게이트가 무력화될 수 있습니다 — 엔진 권한 설정에서 bypassPermissions 를 해제하거나 ADDE 정책(perm_tier)에 맞게 정렬하세요. 기동은 계속합니다.",
  },
  permDiff: {
    queryFailedMsg: "엔진 실효 설정 조회 실패 — 확인불가(보수적 차이 간주)",
    warnLine:
      "[ADDE WARN] 권한 설정 차이: {{reason}} | adde.perm_tier={{tier}} | engine={{engine}}",
    looseEngine: "ADDE 정책(acp) 보다 느슨한 엔진 설정 감지",
    bypassMsg: "엔진 bypass — 권한 요청 미발화로 autopass denylist·자동허용 기록이 무력화됨",
    engineUnknown: "(조회실패)",
  },
  log: {
    supervisor: {
      noConf: "[supervisor] {{proj}}: lanes.d 에 conf 없음",
      legacyKeys:
        "[supervisor] lane={{lane}} 구 평면 어댑터 키 무시: {{keys}} — conf 포맷이 네임스페이스 키(markdown.*/telegram.*)로 변경됨. 레인 재생성 또는 키 이름 변경 필요.",
      heartbeatFail: "[supervisor] lane={{lane}} 하트비트 touch 실패(보조): {{error}}",
      ledgerFail: "[supervisor] lane={{lane}} 세션 장부 갱신 실패(보조): {{error}}",
      deadCleanupFail: "[supervisor] lane={{lane}} dead runtime.json 정리 실패(보조): {{error}}",
      channelWarnFail: "[supervisor] lane={{lane}} 채널 경고 전송 실패(보조): {{error}}",
      injectorStartFail: "[supervisor] lane={{lane}} injector 기동 오류: {{error}}",
      runtimeWriteFail: "[supervisor] lane={{lane}} runtime.json 기록 실패(보조): {{error}}",
      runtimeRemoveFail: "[supervisor] lane={{lane}} runtime.json 제거 실패(보조): {{error}}",
      securePermsFail:
        "[supervisor] lane={{lane}} 상태 디렉터리 권한 잠금 실패(보조 — 파일이 타 사용자에 노출될 수 있음): {{error}}",
      laneStartFail: "[supervisor] lane={{lane}} 기동 실패: {{reason}}",
      laneCleanupFail: "[supervisor] lane={{lane}} 기동 실패 정리(엔진 종료) 실패(보조): {{error}}",
    },
    queue: {
      quarantineFail: "[queue] 손상 메시지 격리 실패 id={{id}}: {{code}}",
      failedWriteFail: "[queue] .failed 기록 실패 id={{id}}: {{error}}",
    },
    injector: {
      injectError: "[injector] inject 오류 lane={{lane}} id={{id}}: {{detail}}",
      failedWriteFail: "[injector] .failed 기록 실패 lane={{lane}} id={{id}}: {{error}}",
      renderError: "[injector] 렌더 오류 lane={{lane}} id={{id}} — 재전송 대기: {{error}}",
      advanceError: "[injector] 진행 오류 lane={{lane}}: {{error}}",
      failNotifyError: "[injector] 실패 알림 전달 오류 lane={{lane}} id={{id}}: {{error}}",
      uncertainNotifyError:
        "[injector] 전달 불확실 통지 전송 오류 lane={{lane}} id={{id}}: {{error}}",
      relaunchError:
        "[injector] 세션 제어 엔진 재기동 실패 lane={{lane}} — 재시작 전까지 레인이 중단될 수 있음: {{error}}",
    },
    telegram: {
      rateLimit: "[telegram] {{method}} 429 레이트리밋 — {{waitMs}}ms 후 재시도({{attempt}})",
      enqueueError: "[telegram] enqueue 오류({{count}}회 연속): {{error}}",
      answerCallbackError: "[telegram] answerCallbackQuery 오류: {{error}}",
      unknownCallback: "[telegram] 알 수 없는 callback decision 무시: {{decision}}",
      unauthorizedMessage:
        "[telegram] 미허가 발신자의 인바운드 무시(from={{from}} chat={{chat}}) — chat_id/allow_from 에 추가해 허용",
      unauthorizedCallback: "[telegram] 미허가 발신자의 권한 콜백 무시(from={{from}})",
      noAuthConfigured:
        "[telegram] 허용 발신자 미설정(chat_id/allow_from 비어있음) — 모든 인바운드 거부(fail-closed)",
      pollError: "[telegram] poll 오류({{count}}회 연속, {{backoff}}ms 후 재시도): {{error}}",
      alertSendError: "[telegram] enqueue 실패 알림 전송 오류: {{error}}",
      pollLoopEnd: "[telegram] poll 루프 종료: {{error}}",
    },
    markdown: {
      quarantineFail: "[markdown] 충돌파일 격리 실패 {{filename}}: {{error}}",
      enqueueError: "[markdown] enqueue 오류({{count}}회 연속) lane={{lane}} id={{id}}: {{error}}",
      alertWriteError: "[markdown] enqueue 실패 알림 기록 오류: {{error}}",
      inboxError: "[markdown] inbox 처리 오류: {{error}}",
      approvalsError: "[markdown] approvals 처리 오류: {{error}}",
      pollError: "[markdown] 폴링 오류: {{error}}",
      decidedMoveError: "[markdown] 결정완료 승인 아카이브 실패 {{file}}: {{error}}",
      backupWarnNotifyFail: "[markdown] 백업/아카이브 경고 노트 기록 실패: {{error}}",
      legacyArchiveMoveError: "[markdown] 구버전 단일 아카이브 파일 이관 실패 {{path}}: {{error}}",
    },
    markdownRetention: {
      relocateFail:
        "[markdown-retention] 이관 실패 {{src}} -> {{dst}}: {{error}} (fail-open, 계속 진행)",
      migrateOutboxFail:
        "[markdown-retention] outbox 마이그레이션 실패 {{name}}: {{error}} (fail-open)",
      migrateDecidedMtimeFail:
        "[markdown-retention] decided mtime 조회 실패 {{name}}: {{error}} (fail-open)",
      migrateDecidedFail:
        "[markdown-retention] decided 마이그레이션 실패 {{name}}: {{error}} (fail-open)",
      maintenanceFail:
        "[markdown-retention] lane={{lane}} 유지작업 실행 실패: {{error}} (fail-open)",
      lastRunWriteFail:
        "[markdown-retention] lane={{lane}} retention-last-run 기록 실패: {{error}}",
    },
    transcript: {
      auditAppendFail:
        "[transcript] 감사 이벤트({{kind}}) append 실패 — 감사 추적 불완전: {{detail}}",
      appendFail: "[transcript] append 실패(보조 — 흡수): {{detail}}",
    },
    acp: {
      engineProcessError: "[acp] lane={{lane}} 엔진 프로세스 오류: {{error}}",
      loadSessionFail:
        "[acp] lane={{lane}} 세션 복귀(session/load) 실패 — 새 세션으로 폴백: {{error}}",
      subscriberError: "[acp] lane={{lane}} 구독자 오류: {{error}}",
      transcriptWriteFail: "[acp] lane={{lane}} transcript 기록 실패: {{error}}",
      permDiff: "[acp] launch perm-diff: {{note}}",
    },
    rotate: {
      fail: "[log-rotate] {{path}} 회전 실패(흡수 — 기록 계속): {{detail}}",
    },
  },
  notify: {
    block: "[ADDE 차단] {{situation}}\n  ↳ 조치: {{action}}",
    exception: "[ADDE 오류] {{situation}}\n  ↳ 조치: {{action}}",
    warn: "[ADDE 경고] {{situation}}\n  ↳ 조치: {{action}}",
  },
} satisfies typeof en;
