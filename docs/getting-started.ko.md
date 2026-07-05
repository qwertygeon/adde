_[English](getting-started.md) | 한국어_

# 시작하기

ADDE 는 AI CLI 엔진(Claude Code 등)을 채널(마크다운 노트 / Telegram)에서 원격 구동하는 게이트웨이입니다. 이 문서는 설치부터 첫 레인 기동까지를 다룹니다.

## 목차

- [요구사항](#요구사항)
- [설치](#설치)
- [핵심 개념](#핵심-개념)
- [레인 설정](#레인-설정)
- [기동·종료](#기동종료)
- [상태·진단](#상태진단)
- [프로젝트 폴더 매핑](#프로젝트-폴더-매핑)
- [제거](#제거)
- [다음 단계](#다음-단계)

## 요구사항

- macOS (1차 타깃)
- Node.js LTS (>=22) — 데몬은 launchd 로 기동되므로 `node` 가 PATH 에 있어야 합니다(`adde up` 이 실행 시점 PATH 를 plist 에 주입).
- AI 엔진 ACP 어댑터 — `adde` 에 `@agentclientprotocol/claude-agent-acp` 가 번들됩니다(별도 설치 불요).
- **Claude 인증**: 엔진은 번들 어댑터를 통해 Claude Code 를 구동하므로, **같은 사용자 계정에서 Claude 가 인증된 상태**여야 합니다(예: Claude Code 로 로그인했거나 `ANTHROPIC_API_KEY` 설정). 미인증 시 엔진 핸드셰이크가 실패해 레인이 기동되지 않습니다 — 먼저 Claude 가 단독으로 동작하는지 확인하세요.

## 설치

**npm 전역 설치**입니다(주 명령은 `adde`):

```bash
npm i -g adde-acp
```

주 진입점은 `adde` 하나입니다. 짧은 별칭(`ad`·`add`)은 기본 설치되지 않으며, 원하면 `adde init`(온보딩 마법사)이나 `adde alias` 로 옵트인 설치할 수 있습니다 — [명령 레퍼런스](commands.ko.md#alias--단축-별칭-설치) 참고.

> **권한 오류(EACCES)**: 시스템/Homebrew Node(root 소유 prefix)에서 흔합니다. `sudo npm i -g` 는 권하지 않습니다(패키지가 root 소유가 되어 이후 업데이트가 깨짐). 버전 매니저(nvm/fnm)를 쓰거나 사용자 prefix(`npm config set prefix ~/.local` + `~/.local/bin` 을 PATH 에)를 설정하세요.
>
> **소스에서 실행(개발·기여)**: `pnpm install && pnpm build` 후 `node dist/cli/adde.js ...`. `pnpm run dev` 는 tsx 포그라운드 실행용이며, 데몬(`adde up`)은 빌드본이 필요합니다.

설치 후 `adde doctor` 로 사전조건(Node 버전·ACP 어댑터·설정)을 한 번 점검하면, 레인 기동 단계에서야 드러나는 미비를 미리 잡을 수 있습니다.

```bash
adde doctor        # 프로젝트 인자 없이 전역 환경 점검
```

### 업데이트

```bash
npm i -g adde-acp@latest       # 최신 버전으로 갱신
adde restart <proj>        # 실행 중 레인에 새 버전 적용(재기동 필요)
```

`npm i -g adde-acp@latest` 는 설치 파일을 교체하지만, **이미 실행 중인 데몬은 옛 코드를 메모리에 물고 있으므로** `adde restart <proj>` 로 재기동해야 새 버전이 적용됩니다. 특정 버전 고정은 `npm i -g adde-acp@<x.y.z>`. (`adde status`·`adde doctor` 는 새 버전이 npm 에 올라오면 안내 한 줄을 표시합니다.)

## 핵심 개념

- **레인(lane)**: `(채널 소스 × 백엔드 × 프로젝트 폴더)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **소스(source)**: 지시를 받는 채널. `markdown`(노트 파일 감시, 예: Obsidian) 또는 `telegram`(봇 long-poll).
- **백엔드(backend)**: AI 엔진 구동 계층. 현재 `acp`(Agent Client Protocol).
- **게이트(gate)**: 모든 권한 요청을 채널 승인으로 라우팅. 타임아웃(기본 10분)·오류 시 기본 거부(fail-closed). 티어(`acp` 기본 / `autopass` 옵트인)·allowlist·denylist·hard-deny 로 승인 빈도를 조절합니다 — 개념·권장 설정은 [권한 가이드](permissions.ko.md).

## 레인 설정

레인은 **파일 1개 = 레인 1개**입니다. `~/.config/adde/<proj>/lanes.d/<lane>.conf` 에 작성합니다.

### 가장 빠른 시작 — `adde init`

첫 레인을 만드는 가장 빠른 길은 온보딩 마법사입니다:

```bash
adde init [<proj>]
```

전역 `doctor` 를 먼저 돌려 결과를 보여주고 → 단축 별칭 설치 여부를 묻고 → 프로젝트·레인 이름과 레인 필드를 대화형으로 입력받아 → 레인을 생성하고 → 토큰 기록·`adde up` 기동 힌트를 안내합니다(TTY 전용). telegram 레인은 봇 토큰을 마지막에 **가려진 입력**(키 입력 비에코)으로 받아 `.env`(0600)에 기록하며, 비워 두면 나중에 설정합니다. 상세: [명령 레퍼런스](commands.ko.md#init--온보딩-마법사).

### 서브커맨드로 설정

`adde lane` 서브커맨드가 conf 파일을 대신 생성·조회·삭제합니다(직접 편집도 가능).

```bash
# markdown(노트) 레인 생성 (markdown 이 기본 소스)
adde lane add myproj md-claude --root /abs/Notes --inbox inbox.md

# telegram 레인 생성 (작업 폴더·자동허용 도구·회신 대상 지정)
adde lane add myproj tg-claude --source telegram --cwd /abs/project --allowlist Read,Grep --chat-id 12345

# telegram 봇 토큰을 stdin 으로 받아 state/<lane>/.env (0600) 에 기록
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude --source telegram --token-stdin

adde lane ls myproj                # 레인 목록
adde lane show myproj tg-claude    # conf 출력
adde lane rm myproj tg-claude      # conf 삭제
```

```bash
# 대화형 마법사 — TTY 에서 필드 플래그 없이 실행하면 기본 동작(telegram 토큰은 마지막에 가려진 입력)
adde lane add myproj tg-claude
adde lane add myproj tg-claude --interactive   # 마법사 강제; 스크립트용 플래그-온리는 --no-interactive
```

TTY 에서 `adde lane add <proj> <lane>` 를 **필드 플래그 없이** 실행하면 대화형 마법사가 자동으로 뜹니다. 필드 플래그를 하나라도 주거나(또는 `--no-interactive`·비TTY stdin) 비대화형이 됩니다. 플래그별 기본값·전체 옵션은 [명령 레퍼런스](commands.ko.md#lane-add-옵션) 표가 기준입니다(`adde lane help` 로도 확인). 기존 conf 는 `--force` 없이는 덮어쓰지 않습니다. 생성 시 `cwd`·markdown `root` 부재나 토큰 형식 이상은 경고로 안내합니다(생성은 진행).

### conf 키 (직접 편집 시)

공통 키:

```ini
source=markdown         # markdown | telegram
backend=acp
engine=claude-agent-acp  # ACP 엔진 기동 프로필
perm_tier=acp
acp_version=v1
cwd=/abs/project/dir     # 이 레인 AI 의 작업 폴더(프로젝트 폴더 매핑)
allowlist=Read,Grep      # 선택: 승인 빈도 축소(게이트 유지)
```

채널별 추가 키:

- **markdown**: `root=<절대경로, 예: Obsidian vault>`, `inbox=<root 상대>`, (선택) `approvals=`·`outbox=`. → [마크다운 가이드](markdown.ko.md).
- **telegram**: `chat_id=<회신 대상>`(설정하면 **그 chat 의 인바운드도 자동 허용**). 봇 토큰은 conf 가 아니라 `~/.config/adde/<proj>/state/<lane>/.env` 에 `TELEGRAM_BOT_TOKEN=...` 으로 둡니다(인자·로그 비노출). 인바운드는 허용 발신자(`chat_id` ∪ `allow_from`)만 처리하며 미설정 시 전부 거부(fail-closed) — 인증 상세: [telegram.ko.md](telegram.ko.md).

## 기동·종료

```bash
adde up <proj>     # lanes.d 의 모든 레인을 백그라운드 데몬(macOS launchd)으로 기동 — 등록 후 즉시 반환
adde down <proj>   # 데몬 종료(어느 터미널에서든)
adde restart <proj># 데몬 재기동(down + up)
adde --version
```

## 상태·진단

```bash
adde status <proj>            # 레인별 상태 표시 (상태 값 정의: 명령 레퍼런스 status 절)
adde status                   # 인자 생략: 전 프로젝트에서 실행 중 레인 집계 (--all: 정지 포함)
adde doctor <proj>            # 환경·설정 정적 점검(기동 전 자가 진단)
adde logs <proj> <lane>       # 레인 최근 활동(transcript)
adde sessions <proj> <lane>   # 엔진 세션 장부 목록(재개·초기화는 채널 명령)
```

**성공 판정**: `adde status <proj>` 에서 해당 레인이 `running` 이면 기동 성공입니다. `stopped`/`dead`/`stale` 이거나 `adde up` 이 실패하면 [트러블슈팅](troubleshooting.ko.md)으로 넘어가세요.

기동이 안 되거나 응답이 없으면 `adde doctor` 로 먼저 점검하세요. 전체 명령은 [명령 레퍼런스](commands.ko.md), 증상별 조치는 [트러블슈팅](troubleshooting.ko.md)을 참고하세요.

## 프로젝트 폴더 매핑

각 레인의 `cwd` 가 그 레인 AI 의 작업 디렉터리입니다. 레인마다 다른 `cwd` 를 지정하면 **채널/메모와 프로젝트 폴더를 각각 묶어** 여러 개를 동시에 운용할 수 있습니다. conf 를 여러 개 두면 `adde up` 한 번으로 모두 기동됩니다.

## 제거

```bash
adde down <proj>       # 1) 먼저 데몬 종료 — launchd LaunchAgent 등록 해제
npm uninstall -g adde-acp  # 2) 전역 패키지 제거
```

**순서가 중요합니다**: `adde down` 없이 패키지만 지우면 등록된 launchd LaunchAgent 가 남아 재부팅 후에도 (없어진) 실행 파일을 계속 재기동하려 합니다. 프로젝트가 여러 개면 각각 `adde down <proj>` 하세요(등록 상태는 `adde doctor <proj>` 로 확인). 설정·상태 파일(`~/.config/adde/`)은 그대로 남으므로, 완전 삭제하려면 확인 후 이 디렉터리를 지우세요.

## 다음 단계

- 마크다운 노트(예: Obsidian)로 메모 기반 구동: [markdown.ko.md](markdown.ko.md)
- Telegram 봇으로 구동: [telegram.ko.md](telegram.ko.md)
- 권한 게이트·티어 이해: [permissions.ko.md](permissions.ko.md)
- 전체 명령: [commands.ko.md](commands.ko.md)
- 문제 해결: [troubleshooting.ko.md](troubleshooting.ko.md)
- 문서 인덱스: [README.ko.md](README.ko.md)
