_[English](getting-started.md) | 한국어_

# 시작하기

ADDE 는 마크다운 노트로 AI CLI 엔진(Claude Code 등)을 구동하는 게이트웨이이며, 모든 대화를 사용자가 소유하는 vault 안에 검색·연결 가능한 노트로 축적합니다. 이 문서는 설치부터 첫 프로젝트·세션까지 다룹니다.

## 목차

- [요구사항](#요구사항)
- [설치](#설치)
- [핵심 개념](#핵심-개념)
- [프로젝트 생성](#프로젝트-생성)
- [세션 생성](#세션-생성)
- [시작/중지](#시작중지)
- [상태·진단](#상태진단)
- [제거](#제거)
- [다음 단계](#다음-단계)

## 요구사항

- macOS(1차 타깃 — 데몬 제어가 launchd 에 의존)
- PATH 에 Node.js LTS(>=22)
- AI 엔진 ACP 어댑터(`adde` 에 번들됨)
- **Claude 인증**: 엔진이 번들 어댑터를 통해 Claude Code 를 구동하므로 같은 사용자 계정에서 Claude 가 인증돼 있어야 합니다(Claude Code 로그인 또는 `ANTHROPIC_API_KEY` 설정). ADDE 문제를 진단하기 전 Claude 자체가 단독으로 동작하는지 먼저 확인하세요.

## 설치

```bash
npm i -g adde-acp
```

단일 진입점은 `adde`. 짧은 별칭(`ad`, `add`)은 옵트인 — `adde init` 또는 `adde alias` 로 설치([명령 레퍼런스](commands.ko.md#alias--짧은-별칭-설치) 참조).

> **권한 오류(EACCES)**: `sudo npm i -g` 대신 버전 매니저(nvm/fnm)나 사용자 npm prefix 를 쓰세요(root 소유 설치는 이후 업데이트를 깨뜨립니다).
>
> **소스에서 실행(개발)**: `pnpm install && pnpm build` 후 `node dist/cli/adde.js ...`. 데몬(`adde up`)은 빌드가 필요합니다 — `pnpm run dev` 는 tsx 포그라운드 실행 전용입니다.

설치 후 한 번 `adde doctor` 를 실행하세요:

```bash
adde doctor        # 전역 환경 점검, 프로젝트 인자 없음
```

### 업데이트

```bash
npm i -g adde-acp@latest
adde restart <proj>   # 재기동 전까지 데몬은 이전 코드를 메모리에 유지
```

새 버전이 있으면 `adde status`/`adde doctor` 가 한 줄 안내를 출력합니다.

## 핵심 개념

- **프로젝트**: 최상위 단위 — vault 루트(필수)와 선택적 작업 디렉터리. 세션을 임의 개수 보유.
- **세션**: 대화 1건. 자체 식별자·엔진·수명 상태를 가짐 — `active`(엔진 상주) / `hibernated`(엔진 비상주, 다음 턴에서 재개) / `detached`(재개 실패 또는 자가 재기동 포기) / `archived`(승계됨 또는 명시 종료).
- **바인딩**: 채널 주소(예: 마크다운 노트 경로)와 세션의 연결. Surface 는 바인딩만 알 뿐 세션 내부를 모릅니다.
- **vault**: 사용자가 지정한 마크다운 저장소 루트 — 모든 대화가 연결된 노트(턴/세션/프로젝트)로 축적됩니다. 그 안의 유일한 원본은 대화 이벤트 기록이며, 노트·첨부 참조·중복 판정 결과는 전부 재생성 가능합니다(`adde vault rebuild`).
- **엔진**: AI CLI 구동 계층, 현재 ACP 단일(`claude-agent-acp`, 엔진 id `acp` 로 등록).
- **게이트**: 모든 권한 요청을 채널 승인으로 라우팅, 타임아웃·오류 시 fail-closed. [권한 가이드](permissions.ko.md) 참조.

설계 전반을 관통하는 두 독립 축이 있습니다 — **채널**(마크다운; Telegram/Discord 는 아직 미구현)은 세션 내부를 절대 모르고, **엔진**은 선언된 능력(`EngineCaps`)을 통해서만 구동됩니다(코어는 어떤 엔진인지로 분기하지 않음).

## 프로젝트 생성

```bash
adde project add myproj --vault ~/ObsidianVault --cwd /Users/me/work/my-project
```

`--vault` 는 **필수**입니다 — ADDE 는 임의의 기본 저장 위치를 만들지 않습니다(의도적 설계: 대화 이력은 사용자가 소유하는 데이터이며, 어디 둘지는 숨겨진 기본값이 아니라 사용자의 선택입니다). `--cwd` 는 이 프로젝트에서 엔진이 작업할 폴더입니다(선택).

권한 티어 선택 등을 포함한 안내형 흐름을 원하면 온보딩 마법사를 쓰세요:

```bash
adde init [<proj>]
```

`project add` 옵션 전체 표(권한 티어·allowlist/denylist/hard-deny·보관 이관/백업·동기화 제공자)는 [명령 레퍼런스](commands.ko.md#project--프로젝트-관리) 참조.

```bash
adde project ls                    # 프로젝트 목록
adde project show myproj           # 설정 출력
adde project set myproj perm_tier autopass --add-deny "Bash(sudo *)"
```

## 세션 생성

```bash
adde session new myproj --title "frontend work"
```

각 세션은 자체 대화 이력·엔진 재개 핸들을 가지며, (markdown 서페이스의 경우) `<vault>/adde/projects/myproj/sessions/<sid>/inbox.md` 아래 입력 노트가 만들어집니다. 이 노트는 프로젝트 데몬이 실행 중이면 몇 초 안에 나타나고(아래 [시작/중지](#시작중지) 참조), 아직 실행 전이면 데몬을 시작한 뒤에 나타납니다. 그 노트를 편집해 지시를 보냅니다 — 팔레트·작성 영역·기록 존 전체 레이아웃은 [마크다운 가이드](markdown.ko.md) 참조.

```bash
adde session ls myproj             # 세션 목록
adde session show myproj <sid>     # 세션 상세
adde session clear myproj <sid>    # 승계 — 새 세션 생성, 기존 세션은 archived(삭제 아님)
```

## 시작/중지

```bash
adde up <proj>       # 프로젝트 데몬 시작(macOS launchd) — 등록 직후 즉시 반환
adde down <proj>     # 데몬 종료(어느 터미널에서든)
adde restart <proj>  # 데몬 재시작 — 프로젝트 설정 변경 후 필수
```

프로젝트당 데몬 1개가 모든 세션을 호스팅합니다. 부팅 시 `active` 였던 모든 세션이 저장된 엔진 재개 핸들로 자동 재개됩니다.

## 상태·진단

```bash
adde status <proj>            # 세션별 상태 표
adde status                   # 인자 없음: 전 프로젝트 집계
adde doctor <proj>            # 환경·설정 정적 점검
adde logs <proj> <sid>        # 최근 세션 활동(대화 이벤트 기록)
```

**성공 확인**: `adde status <proj>` 에서 세션이 `active`(또는 유휴 후 `hibernated` — 정상)로 보이면 데몬과 그 세션은 정상입니다. `detached` 는 조치가 필요하다는 뜻입니다 — [트러블슈팅](troubleshooting.ko.md) 참조.

## 제거

```bash
adde down <proj>              # 1) 데몬 먼저 종료 — launchd LaunchAgent 등록 해제
npm uninstall -g adde-acp     # 2) 전역 패키지 제거
```

제거 전 각 프로젝트마다 `adde down <proj>` 를 실행하세요(`adde doctor <proj>` 로 확인) — 그렇지 않으면 남은 launchd 등록이 사라진 실행 파일을 계속 재기동하려 시도합니다. 설정 파일(`~/.config/adde/`)은 제거 후에도 남으므로, 전부 지우려면 그 디렉터리를 삭제하세요. **vault(대화 이력)는 제거로 절대 건드려지지 않습니다** — 사용자가 지정한 경로의 평범한 마크다운 파일이기 때문입니다.

## 다음 단계

- 마크다운 노트(예: Obsidian)로 구동하기: [markdown.md](markdown.ko.md)
- 권한 게이트와 티어 이해하기: [permissions.md](permissions.ko.md)
- 전체 명령 세트: [commands.md](commands.ko.md)
- 트러블슈팅: [troubleshooting.md](troubleshooting.ko.md)
- 문서 색인: [README.md](README.ko.md)
