<!-- 언어: [English](README.md) | **한국어** -->

# ADDE — Ai Driven Development Engine

_[English](README.md) | 한국어_

[![npm](https://img.shields.io/npm/v/adde-acp)](https://www.npmjs.com/package/adde-acp)
[![CI](https://github.com/qwertygeon/adde/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertygeon/adde/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/adde-acp)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/adde-acp)](LICENSE)

> ⚠️ **상태: 초기 개발.** v2 코어(프로젝트/세션/바인딩 모델, ACP 엔진 드라이버, 마크다운 채널)는 동작하며, Telegram/Discord 는 등록만 되어 있고 본 릴리스에서는 미구현(stub)입니다. API 변동 가능.

ADDE 는 **AI CLI**(Claude Code 등)를 **채널**(현재는 마크다운 노트(예: Obsidian); Telegram/Discord 는 아직 미구현)에서 구동하는 게이트웨이로, 모든 대화를 사용자가 소유하는 vault 안에 검색·연결 가능한 노트로 축적합니다. AI 가 개발 작업을 수행하고, 사람은 노트로 지시·승인·관찰합니다.

## 이럴 때 씁니다

- 프로젝트의 **모든 AI 대화가 턴 단위로 연결되고 검색 가능한 나만의 마크다운 노트로 축적**되길 원할 때(이미 쓰는 도구로 동기화 가능).
- 자리를 비운 사이 노트(Obsidian)에서 프로젝트별 AI 에게 **지시·권한 승인·결과 확인**을 하고 싶을 때.
- 같거나 다른 프로젝트 폴더에 대해 **여러 독립 대화(세션)를 동시에** 진행하고 싶을 때.
- 모든 도구 실행에 **사람의 승인 게이트**(기본 fail-closed)를 두고 싶을 때.

> ⚠️ **데이터 흐름 주의**: 보낸 지시·코드·AI 응답은 AI 엔진 제공자(ACP→Claude 등)를 거칩니다. 승인·턴 노트는 **동기 vault(Obsidian Sync·iCloud 등)로 복제**됩니다 — 민감 프로젝트의 노트 배치 주의는 [마크다운 가이드 — 민감 정보와 vault 배치](docs/markdown.ko.md#민감-정보와-vault-배치)를 먼저 읽으세요.
>
> ℹ️ **비공식 도구.** ADDE 는 Anthropic 이나 엔진·채널 제공자가 만들거나 보증하지 않은 비공식 서드파티 도구입니다. "Claude"·"Claude Code" 는 Anthropic 의 상표이며, 그 외 엔진·플랫폼명은 각 소유자의 상표입니다. 본 프로젝트는 이들과 제휴 관계가 없습니다.
>
> 📜 **상위 서비스 약관이 적용됩니다.** AI 엔진 구동은 사용자의 콘텐츠를 해당 엔진 제공자(예: Claude 는 Anthropic API)로 전송하므로, 사용자 본인의 요금제 약관·이용정책이 적용됩니다. [SECURITY.md → 운영자 책임](SECURITY.md#your-responsibilities-as-an-operator) 참조.

## 빠른 시작

```sh
npm i -g adde-acp     # 전역 설치
adde init             # 가이드 설정 (환경 점검 + 짧은 별칭 + 첫 프로젝트 생성)
```

`adde init` 은 `doctor`(환경 점검) → 짧은 별칭(`ad`/`add`) 설치(옵트인) → 대화형 첫 프로젝트 생성(vault 경로 + 권한 설정)을 한 흐름으로 안내합니다. 수동 설정은 [시작하기](docs/getting-started.ko.md) 참조.

## 사용자 문서

- [시작하기](docs/getting-started.ko.md) — 설치·핵심 개념·첫 프로젝트·세션·상태/진단
- [마크다운 가이드](docs/markdown.ko.md) — 노트(예: Obsidian)로 AI 구동하기(팔레트·지시·턴 노트·승인)
- [권한 가이드](docs/permissions.ko.md) — 게이트·티어(acp/autopass)·allowlist/denylist·하드-거부·권장 설정
- [명령 레퍼런스](docs/commands.ko.md) · [트러블슈팅](docs/troubleshooting.ko.md) · [Telegram/Discord 상태](docs/telegram.ko.md)(미구현)

## 핵심 설계

- **ACP 우선**: 엔진을 헤드리스 [Agent Client Protocol](https://agentclientprotocol.com) 서브프로세스로 띄우고 ADDE 가 ACP 클라이언트로 구동합니다. 지시·응답·권한·로그·사용량이 단일 이벤트 스트림으로 처리됩니다(터미널 스크래핑 없음).
- **엔진 독립**: 엔진은 레지스트리(`ENGINE_REGISTRY`) 뒤에서 선언된 `EngineCaps` 능력 집합을 통해서만 구동됩니다 — 코어는 어떤 엔진인지로 절대 분기하지 않습니다. 현재 엔진 1종(`acp`, `claude-agent-acp` 구동)이 등록되어 있습니다.
- **채널 독립**: `Surface`(채널 어댑터)는 채널 주소와 세션의 바인딩만 알 뿐 세션 내부를 절대 모릅니다. 현재 `markdown` 만 구현되어 있고 `telegram`/`discord` 는 등록만 됨(stub).
- **무손실 기록, 재생성 가능한 노트**: 모든 턴의 모든 이벤트가 절대 삭제·덮어쓰지 않는 대화 이벤트 기록에 append 됩니다(크래시 안전, 크기 대신 세대 분할). 노트(턴/세션/프로젝트)는 그 기록의 순수 파생물이라 — 삭제·손상돼도 `adde vault rebuild` 가 정확히 재생성합니다.
- **fail-closed 권한**: 모든 권한 요청을 채널 승인으로 라우팅하고, 타임아웃·오류 시 기본 deny. 프로젝트별 옵트인 `autopass` 티어(denylist 도구만 확인, 그 외 자동 허용·전량 기록)와, 티어 무관 즉시 거부하는 **하드-거부**(`--safe-defaults` 로 sudo·rm -rf·자격증명 읽기 등 방어심화 기본 차단)도 제공합니다.
- **i18n(en/ko)**: CLI 출력·채널 메시지가 영어/한국어를 지원합니다. 로케일 자동 감지(`ADDE_LANG` > 시스템 로케일 `LC_ALL`/`LC_MESSAGES`/`LANG` > 기본 en) + 프로젝트별 채널 언어(`project set <proj> lang <en|ko>`). 상세는 [명령 레퍼런스](docs/commands.ko.md)의 "언어(로케일)".

## 명령

```sh
adde init [<proj>]                     # 가이드 설정 (doctor + 짧은 별칭 + 프로젝트 생성)
adde up <proj> [--json]                # 프로젝트의 모든 세션을 백그라운드 데몬으로 기동 (macOS launchd)
adde down <proj> [--json]              # 데몬 종료 — 어느 터미널에서든 동작
adde restart <proj> [--json]           # 데몬 재기동 (down + up)
adde status [<proj>] [--all] [--json]  # 세션 상태 (<proj> 생략 시 전 프로젝트, --all 은 archived 포함)
adde doctor [<proj>] [--json]          # 환경·설정 정적 점검
adde logs <proj> <session> [N] [--engine] [-f]  # 세션 이벤트 로그(--engine 시 엔진 진단 로그)
adde project <add|set|show|ls|rm>      # 프로젝트 관리(vault 경로·권한 티어·보관 이관 등)
adde session <new|ls|show|clear|rm>    # 세션 관리(대화 단위)
adde bind <add|rm|ls>                  # 채널↔세션 바인딩 관리
adde vault <rebuild>                   # 이벤트 기록에서 노트/중복 판정 원장 재생성
adde alias [names...]                  # 짧은 별칭(ad·add) 설치 — adde 실행 파일 옆에
adde completion <bash|zsh>             # 셸 자동완성 스크립트 출력
```

핵심 개념은 [시작하기](docs/getting-started.ko.md#핵심-개념), 전체 명령은 [명령 레퍼런스](docs/commands.ko.md)를 참조하세요.

## 설치 / 런타임

- 설치: **npm 전역 설치** `npm i -g adde-acp`. 업데이트는 `npm i -g adde-acp@latest` 후 `adde restart <proj>`(`status`/`doctor` 가 새 버전을 안내). 개발·기여는 소스 빌드(`pnpm install && pnpm build`). 상세·권한(EACCES) 안내: [시작하기](docs/getting-started.ko.md#설치).
- 짧은 별칭 `ad`·`add` 는 자동 설치되지 않습니다 — `adde init` 또는 `adde alias` 로 옵트인 설치합니다(전역 명령명 충돌 회피).
- TypeScript + Node.js LTS (>=22)
- **AI 엔진 ACP 어댑터 필수**(예: `@agentclientprotocol/claude-agent-acp`) — `adde doctor` 가 사전 점검합니다.
- macOS 1차 타깃 — `adde up`/`down`/`restart` 는 macOS launchd LaunchAgent 기반. 재부팅·로그아웃 후 자동 복구 및 세션 자동 재개. Linux/WSL은 현재 지원 범위 밖.

## 상태 / 로드맵

- [x] v0.2.x: `markdown | telegram → claude(ACP)` 레인 기반 수직 슬라이스
- [x] v2 코어: 프로젝트/세션/바인딩 모델, 무손실 기록 저장소, `EngineDriver`/`Surface` 레지스트리, 마크다운 채널(3존 노트 레이아웃), 자동 재개/유휴 내림, 자가 회복
- [ ] Telegram/Discord 채널 구현(현재 stub) · 추가 엔진 드라이버 · 비-ACP CLI 스크래핑(보류)

## 라이선스 / 보안 / 메타

- 라이선스: [MIT](LICENSE)
- 보안 취약점 보고: [SECURITY.md](SECURITY.md)
- 프로젝트 메타: [변경 이력](CHANGELOG.md) · [기여 가이드](CONTRIBUTING.ko.md)

---

<sub>전신 프로젝트: [cctg](https://qwertygeon.github.io/cctg/) (Claude Code Tmux Gateway). ADDE 는 cctg 의 `claude --channels` 의존을 걷어내고 ACP 기반으로 재설계한 후속 제품입니다.</sub>
