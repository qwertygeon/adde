# ADDE — Ai Driven Development Engine

> ⚠️ **상태: 초기 개발.** ACP 백엔드 + Telegram/마크다운 소스 어댑터 동작(PoC 수직 슬라이스). API 변동 가능.

ADDE 는 **AI CLI**(Claude Code / Codex 등)를 **채널**(Telegram / 마크다운 노트(예: Obsidian); Discord 보류)에서 원격 구동하는 게이트웨이입니다. AI 가 개발 작업을 수행하고, 사람은 채팅으로 지시·승인·관찰합니다.

## 이럴 때 씁니다

- 자리를 비운 사이 폰(Telegram)이나 노트(Obsidian)에서 프로젝트별 AI 에게 **지시·권한 승인·결과 확인**을 하고 싶을 때.
- 여러 프로젝트를 각각의 작업 폴더에 묶어(레인) **동시에** 원격 운용하고 싶을 때.
- 모든 도구 실행에 **사람의 승인 게이트**(기본 fail-closed)를 두고 싶을 때.

> ⚠️ **데이터 흐름 주의**: 보낸 지시·코드·AI 응답은 AI 엔진 제공자(ACP→Claude/Codex 등)와 채널 인프라(Telegram)를 거칩니다. 마크다운 소스를 쓰면 승인·출력 노트가 **동기 vault(Obsidian Sync·iCloud 등)로 복제**됩니다 — 민감 프로젝트의 노트 배치 주의는 [마크다운 가이드 — 민감 정보 노출](docs/markdown.md#동기화-vault-와-민감-정보-노출)을 먼저 읽으세요.

## 사용자 문서

- [시작하기](docs/getting-started.md) — 설치·레인 설정·기동·상태/진단·프로젝트 폴더 매핑
- [Telegram 가이드](docs/telegram.md) — 봇 생성·토큰·기동 단계별
- [마크다운 가이드](docs/markdown.md) — 노트(예: Obsidian)로 AI 구동하기(지시·응답·권한 승인 단계별)
- [권한 가이드](docs/permissions.md) — 게이트·티어(acp/autopass)·allowlist/denylist·권장 설정
- [명령 레퍼런스](docs/commands.md) · [트러블슈팅](docs/troubleshooting.md)

## 핵심 설계

- **ACP 우선**: 엔진을 헤드리스 [Agent Client Protocol](https://agentclientprotocol.com) 서브프로세스로 띄우고 ADDE 가 ACP 클라이언트로 구동합니다. 지시·응답·권한·로그·사용량이 단일 이벤트 스트림으로 처리됩니다(터미널 스크래핑 없음).
- **엔진 독립**: `claude-code-acp`·`codex-acp` 가 같은 프로토콜을 말하므로 단일 백엔드 어댑터가 여러 엔진을 구동합니다.
- **레인 격리**: `(source × backend × project)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **fail-closed 권한**: 모든 권한 요청을 채널 승인으로 라우팅하고, 타임아웃·오류 시 기본 deny. 레인별 옵트인 `autopass` 티어(denylist 도구만 확인, 그 외 자동 허용·전량 기록)도 제공합니다.
- **i18n(en/ko)**: CLI 출력·채널 메시지가 영어/한국어를 지원합니다. 로케일 자동 감지(`ADDE_LANG` > 시스템 로케일 `LC_ALL`/`LC_MESSAGES`/`LANG` > 기본 en) + 레인별 채널 언어(`lane add --lang`). 상세는 [명령 레퍼런스](docs/commands.md)의 "언어(로케일)".

## 명령

```sh
adde up <proj>               # 프로젝트의 모든 레인을 백그라운드 데몬으로 기동 (macOS launchd)
adde down <proj>             # 데몬 종료 — 어느 터미널에서든 동작
adde restart <proj>          # 데몬 재기동 (down + up)
adde status [<proj>] [--all] [--json]  # 레인 상태 (<proj> 생략 시 전 프로젝트 실행 중 집계, --all 정지 포함)
adde doctor [<proj>]         # 환경·설정 정적 점검 (데몬 등록 상태 포함)
adde logs <proj> <lane> [N] [--engine]  # 레인 transcript(또는 --engine 시 엔진 stderr) 최근 N줄
adde sessions <proj> <lane>  # 엔진 세션 장부 목록 (재개/초기화는 채널 명령 — commands.md)
adde lane add <proj> <lane>  # 레인 conf 생성 (옵션: --source/--cwd/--chat-id/--root/--interactive …)
adde lane ls <proj>          # 레인 목록
adde lane show <proj> <lane> # 레인 conf 출력
adde lane rm <proj> <lane>   # 레인 conf 삭제
add  …                       # adde 단축 별칭
```

레인 설정 상세는 [시작하기](docs/getting-started.md#레인-설정), 전체 명령은 [명령 레퍼런스](docs/commands.md)를 참조하세요.

## 설치 / 런타임

- 설치: **npm 전역 설치** `npm i -g adde`. 업데이트는 `npm i -g adde@latest` 후 `adde restart <proj>`. 개발·기여는 소스 빌드(`pnpm install && pnpm build`). 상세·권한(EACCES) 안내: [시작하기](docs/getting-started.md#설치).
- TypeScript + Node.js LTS (>=22)
- **AI 엔진 ACP 어댑터 필수**(예: `@zed-industries/claude-code-acp`) — `adde doctor` 가 사전 점검합니다.
- macOS 1차 타깃 — `adde up`/`down`/`restart` 는 macOS launchd LaunchAgent 기반. 재부팅·로그아웃 후 자동 복구. Linux/WSL은 현재 지원 범위 밖.

## 상태 / 로드맵

- [x] 설계 (ACP 우선 재설계 완료)
- [x] 개발환경 스캐폴드 (TypeScript · pnpm · CI)
- [x] PoC (ACP 스파이크 · 권한 라우팅)
- [~] MVP: `markdown | telegram → claude(ACP)` 수직 슬라이스 (소스 어댑터·레인별 프로젝트 폴더 매핑 동작)
- [ ] Codex 백엔드 · Discord(보류) · 비-ACP CLI 스크래핑(보류)

## 라이선스 / 보안

- 라이선스: [MIT](LICENSE)
- 보안 취약점 보고: [SECURITY.md](SECURITY.md)

---

<sub>전신 프로젝트: [cctg](https://qwertygeon.github.io/cctg/) (Claude Code Tmux Gateway). ADDE 는 cctg 의 `claude --channels` 의존을 걷어내고 ACP 기반으로 재설계한 후속 제품입니다.</sub>
