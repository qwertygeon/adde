# 시작하기

ADDE 는 AI CLI 엔진(Claude Code 등)을 채널(Telegram / 마크다운 노트)에서 원격 구동하는 게이트웨이입니다. 이 문서는 설치부터 첫 레인 기동까지를 다룹니다.

## 목차

- [요구사항](#요구사항)
- [설치](#설치)
- [핵심 개념](#핵심-개념)
- [레인 설정](#레인-설정)
- [기동·종료](#기동종료)
- [상태·진단](#상태진단)
- [프로젝트 폴더 매핑](#프로젝트-폴더-매핑)
- [다음 단계](#다음-단계)

## 요구사항

- macOS (1차 타깃)
- Node.js LTS (>=22)
- AI 엔진 ACP 어댑터 (예: `@zed-industries/claude-code-acp`)

## 설치

```bash
pnpm install
pnpm build
```

설치 후 `adde doctor` 로 사전조건(Node 버전·ACP 어댑터·설정)을 한 번 점검하면, 레인 기동 단계에서야 드러나는 미비를 미리 잡을 수 있습니다.

```bash
adde doctor        # 프로젝트 인자 없이 전역 환경 점검
```

## 핵심 개념

- **레인(lane)**: `(채널 소스 × 백엔드 × 프로젝트 폴더)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **소스(source)**: 지시를 받는 채널. `telegram`(봇 long-poll) 또는 `markdown`(노트 파일 감시, 예: Obsidian).
- **백엔드(backend)**: AI 엔진 구동 계층. 현재 `acp`(Agent Client Protocol).
- **게이트(gate)**: 모든 권한 요청을 채널 승인으로 라우팅. 타임아웃·오류 시 기본 거부(fail-closed).

## 레인 설정

레인은 **파일 1개 = 레인 1개**입니다. `~/.config/adde/<proj>/lanes.d/<lane>.conf` 에 작성합니다.

### 서브커맨드로 설정 (권장)

`adde lane` 서브커맨드가 conf 파일을 대신 생성·조회·삭제합니다(직접 편집도 가능).

```bash
# telegram 레인 생성 (작업 폴더·자동허용 도구·회신 대상 지정)
adde lane add myproj tg-claude --cwd /abs/project --allowlist Read,Grep --chat-id 12345

# telegram 봇 토큰을 stdin 으로 받아 state/<lane>/.env (0600) 에 기록
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude --token-stdin

# markdown(노트) 레인 생성
adde lane add myproj md-claude --source markdown --root /abs/Notes --inbox inbox.md

adde lane ls myproj                # 레인 목록
adde lane show myproj tg-claude    # conf 출력
adde lane rm myproj tg-claude      # conf 삭제
```

```bash
# 플래그 암기 없이 대화형으로 생성 (TTY 전용, 토큰은 묻지 않음)
adde lane add myproj tg-claude --interactive
```

기본값: `--source telegram`, `--backend acp`, `--engine claude-code-acp`, `--channel`=source, `--perm-tier acp`, `--acp-version v1`. 기존 conf 는 `--force` 없이는 덮어쓰지 않습니다. 생성 시 `cwd`·markdown `root` 부재나 토큰 형식 이상은 경고로 안내합니다(생성은 진행). 전체 옵션은 `adde lane help` 또는 [명령 레퍼런스](commands.md#lane-add-옵션).

### conf 키 (직접 편집 시)

공통 키:

```ini
source=telegram         # telegram | markdown
backend=acp
engine=claude-code-acp  # ACP 엔진 기동 프로필
channel=telegram        # 게이트 분기용
perm_tier=acp
acp_version=v1
cwd=/abs/project/dir     # 이 레인 AI 의 작업 폴더(프로젝트 폴더 매핑)
allowlist=Read,Grep      # 선택: 승인 빈도 축소(게이트 유지)
```

채널별 추가 키:

- **telegram**: `chat_id=<회신 대상>`. 봇 토큰은 conf 가 아니라 `~/.config/adde/<proj>/state/<lane>/.env` 에 `TELEGRAM_BOT_TOKEN=...` 으로 둡니다(인자·로그 비노출). 단계별: [telegram.md](telegram.md).
- **markdown**: `root=<절대경로, 예: Obsidian vault>`, `inbox=<root 상대>`, (선택) `approvals=`·`outbox=`. → [마크다운 가이드](markdown.md).

## 기동·종료

```bash
adde up <proj>     # lanes.d 의 모든 레인 기동(포그라운드 상주)
adde down <proj>   # 레인 종료
adde --version
```

## 상태·진단

```bash
adde status <proj>            # 레인 상태: running / dead(크래시) / stopped
adde doctor <proj>            # 환경·설정 정적 점검(기동 전 자가 진단)
adde logs <proj> <lane>       # 레인 최근 활동(transcript)
```

기동이 안 되거나 응답이 없으면 `adde doctor` 로 먼저 점검하세요. 전체 명령은 [명령 레퍼런스](commands.md), 증상별 조치는 [트러블슈팅](troubleshooting.md)을 참고하세요.

## 프로젝트 폴더 매핑

각 레인의 `cwd` 가 그 레인 AI 의 작업 디렉터리입니다. 레인마다 다른 `cwd` 를 지정하면 **채널/메모와 프로젝트 폴더를 각각 묶어** 여러 개를 동시에 운용할 수 있습니다. conf 를 여러 개 두면 `adde up` 한 번으로 모두 기동됩니다.

## 다음 단계

- Telegram 봇으로 구동: [telegram.md](telegram.md)
- 마크다운 노트(예: Obsidian)로 메모 기반 구동: [markdown.md](markdown.md)
- 전체 명령: [commands.md](commands.md)
- 문제 해결: [troubleshooting.md](troubleshooting.md)
- 문서 인덱스: [README.md](README.md)
