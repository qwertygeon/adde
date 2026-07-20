<!-- 언어: [English](README.md) | **한국어** -->

# ADDE — Ai Driven Development Engine

_[English](README.md) | 한국어_

[![npm](https://img.shields.io/npm/v/adde-acp)](https://www.npmjs.com/package/adde-acp)
[![CI](https://github.com/qwertygeon/adde/actions/workflows/ci.yml/badge.svg)](https://github.com/qwertygeon/adde/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/adde-acp)](https://nodejs.org)
[![license: MIT](https://img.shields.io/npm/l/adde-acp)](LICENSE)

> ⚠️ **상태: 초기 개발.** ACP 백엔드 + 마크다운/Telegram 소스 어댑터 동작(PoC 수직 슬라이스). API 변동 가능.

ADDE 는 **AI CLI**(Claude Code / Codex 등)를 **채널**(마크다운 노트(예: Obsidian) / Telegram; Discord 보류)에서 원격 구동하는 게이트웨이입니다. AI 가 개발 작업을 수행하고, 사람은 노트나 채팅으로 지시·승인·관찰합니다.

## 이럴 때 씁니다

- 자리를 비운 사이 폰(Telegram)이나 노트(Obsidian)에서 프로젝트별 AI 에게 **지시·권한 승인·결과 확인**을 하고 싶을 때.
- 여러 프로젝트를 각각의 작업 폴더에 묶어(레인) **동시에** 원격 운용하고 싶을 때.
- 모든 도구 실행에 **사람의 승인 게이트**(기본 fail-closed)를 두고 싶을 때.

> ⚠️ **데이터 흐름 주의**: 보낸 지시·코드·AI 응답은 AI 엔진 제공자(ACP→Claude/Codex 등)와 채널 인프라(Telegram)를 거칩니다. 마크다운 소스를 쓰면 승인·출력 노트가 **동기 vault(Obsidian Sync·iCloud 등)로 복제**됩니다 — 민감 프로젝트의 노트 배치 주의는 [마크다운 가이드 — 민감 정보 노출](docs/markdown.ko.md#동기화-vault-와-민감-정보-노출)을 먼저 읽으세요.
>
> ℹ️ **비공식 도구.** ADDE 는 Anthropic 이나 엔진·채널 제공자가 만들거나 보증하지 않은 비공식 서드파티 도구입니다. "Claude"·"Claude Code" 는 Anthropic 의 상표이며, 그 외 엔진·플랫폼명은 각 소유자의 상표입니다. 본 프로젝트는 이들과 제휴 관계가 없습니다.
>
> 📜 **상위 서비스 약관이 적용됩니다.** AI 엔진 구동은 사용자의 콘텐츠를 해당 엔진 제공자(예: Claude 는 Anthropic API)로 전송하므로, 사용자 본인의 요금제 약관·이용정책이 적용됩니다. 또한 Telegram 봇을 운영하면 사용자가 봇 운영자가 됩니다(본인 외 접근 가능하면 AI 임을 고지). [SECURITY.md → 운영자 책임](SECURITY.md#your-responsibilities-as-an-operator) 참조.

## 빠른 시작

```sh
npm i -g adde-acp     # 전역 설치
adde init         # 가이드 설정 (환경 점검 + 짧은 별칭 + 첫 레인 생성)
```

`adde init` 은 `doctor`(환경 점검) → 짧은 별칭(`ad`/`add`) 설치(옵트인) → 대화형 레인 생성을 한 흐름으로 안내합니다. 수동 설정은 [시작하기](docs/getting-started.ko.md) 참조.

## 사용자 문서

- [시작하기](docs/getting-started.ko.md) — 설치·레인 설정·기동·상태/진단·프로젝트 폴더 매핑
- [마크다운 가이드](docs/markdown.ko.md) — 노트(예: Obsidian)로 AI 구동하기(지시·응답·권한 승인 단계별)
- [Telegram 가이드](docs/telegram.ko.md) — 봇 생성·토큰·기동 단계별
- [권한 가이드](docs/permissions.ko.md) — 게이트·티어(acp/autopass)·allowlist/denylist·하드-거부·권장 설정
- [명령 레퍼런스](docs/commands.ko.md) · [트러블슈팅](docs/troubleshooting.ko.md)

## 핵심 설계

- **ACP 우선**: 엔진을 헤드리스 [Agent Client Protocol](https://agentclientprotocol.com) 서브프로세스로 띄우고 ADDE 가 ACP 클라이언트로 구동합니다. 지시·응답·권한·로그·사용량이 단일 이벤트 스트림으로 처리됩니다(터미널 스크래핑 없음).
- **엔진 독립**: `claude-agent-acp`·`codex-acp` 가 같은 프로토콜을 말하므로 단일 백엔드 어댑터가 여러 엔진을 구동합니다.
- **레인 격리**: `(source × backend × project)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **fail-closed 권한**: 모든 권한 요청을 채널 승인으로 라우팅하고, 타임아웃·오류 시 기본 deny. 레인별 옵트인 `autopass` 티어(denylist 도구만 확인, 그 외 자동 허용·전량 기록)와, 티어 무관 즉시 거부하는 **하드-거부**(`--safe-defaults` 로 sudo·rm -rf·자격증명 읽기 등 방어심화 기본 차단)도 제공합니다.
- **i18n(en/ko)**: CLI 출력·채널 메시지가 영어/한국어를 지원합니다. 로케일 자동 감지(`ADDE_LANG` > 시스템 로케일 `LC_ALL`/`LC_MESSAGES`/`LANG` > 기본 en) + 레인별 채널 언어(`lane add --lang`). 상세는 [명령 레퍼런스](docs/commands.ko.md)의 "언어(로케일)".

## 명령

```sh
adde init [<proj>]           # 가이드 설정 (doctor + 짧은 별칭 + 레인 생성)
adde up <proj>               # 프로젝트의 모든 레인을 백그라운드 데몬으로 기동 (macOS launchd)
adde down <proj>             # 데몬 종료 — 어느 터미널에서든 동작
adde restart <proj>          # 데몬 재기동 (down + up)
adde status [<proj>] [--all] [--json]  # 레인 상태 (<proj> 생략 시 전 프로젝트 실행 중 집계, --all 정지 포함)
adde doctor [<proj>]         # 환경·설정 정적 점검 (데몬 등록·파일 권한 포함)
adde logs <proj> <lane> [N] [--engine]  # 레인 transcript(또는 --engine 시 엔진 stderr) 최근 N줄
adde sessions <proj> <lane>  # 엔진 세션 장부 목록 (재개/초기화는 채널 명령 — commands.md)
adde lane add <proj> <lane>  # 레인 conf 생성 (옵션: --source/--cwd/--chat-id/--root/--safe-defaults/--interactive …)
adde lane set <proj> <lane> [<key> <value> …]  # 레인 conf 제자리 편집 (TTY 에서 인자 없이: 대화형 마법사)
adde lane ls <proj>          # 레인 목록
adde lane show <proj> <lane> [key]  # 레인 conf 출력 (key 를 주면 값/기본값/메타)
adde lane rm <proj> <lane>   # 레인 conf 삭제
adde alias [names...]        # 짧은 별칭(ad·add) 설치 — adde 실행 파일 옆에
adde completion <bash|zsh>   # 셸 자동완성 스크립트 출력
```

레인 설정 상세는 [시작하기](docs/getting-started.ko.md#레인-설정), 전체 명령은 [명령 레퍼런스](docs/commands.ko.md)를 참조하세요.

## 설치 / 런타임

- 설치: **npm 전역 설치** `npm i -g adde-acp`. 업데이트는 `npm i -g adde-acp@latest` 후 `adde restart <proj>`(`status`/`doctor` 가 새 버전을 안내). 개발·기여는 소스 빌드(`pnpm install && pnpm build`). 상세·권한(EACCES) 안내: [시작하기](docs/getting-started.ko.md#설치).
- 짧은 별칭 `ad`·`add` 는 자동 설치되지 않습니다 — `adde init` 또는 `adde alias` 로 옵트인 설치합니다(전역 명령명 충돌 회피).
- TypeScript + Node.js LTS (>=22)
- **AI 엔진 ACP 어댑터 필수**(예: `@agentclientprotocol/claude-agent-acp`) — `adde doctor` 가 사전 점검합니다.
- macOS 1차 타깃 — `adde up`/`down`/`restart` 는 macOS launchd LaunchAgent 기반. 재부팅·로그아웃 후 자동 복구. Linux/WSL은 현재 지원 범위 밖.

## 상태 / 로드맵

- [x] 설계 (ACP 우선 재설계 완료)
- [x] 개발환경 스캐폴드 (TypeScript · pnpm · CI)
- [x] PoC (ACP 스파이크 · 권한 라우팅)
- [~] MVP: `markdown | telegram → claude(ACP)` 수직 슬라이스 (소스 어댑터·레인별 프로젝트 폴더 매핑 동작)
- [ ] Codex 백엔드 · Discord(보류) · 비-ACP CLI 스크래핑(보류)

## 라이선스 / 보안 / 메타

- 라이선스: [MIT](LICENSE)
- 보안 취약점 보고: [SECURITY.md](SECURITY.md)
- 프로젝트 메타: [변경 이력](CHANGELOG.md) · [기여 가이드](CONTRIBUTING.ko.md)

---

<sub>전신 프로젝트: [cctg](https://qwertygeon.github.io/cctg/) (Claude Code Tmux Gateway). ADDE 는 cctg 의 `claude --channels` 의존을 걷어내고 ACP 기반으로 재설계한 후속 제품입니다.</sub>
