# 시작하기

ADDE 는 AI CLI 엔진(Claude Code 등)을 채널(Telegram / 마크다운 노트)에서 원격 구동하는 게이트웨이입니다. 이 문서는 설치부터 첫 레인 기동까지를 다룹니다.

## 목차

- [요구사항](#요구사항)
- [설치](#설치)
- [핵심 개념](#핵심-개념)
- [레인 설정](#레인-설정)
- [기동·종료](#기동종료)
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

## 핵심 개념

- **레인(lane)**: `(채널 소스 × 백엔드 × 프로젝트 폴더)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **소스(source)**: 지시를 받는 채널. `telegram`(봇 long-poll) 또는 `markdown`(노트 파일 감시, 예: Obsidian).
- **백엔드(backend)**: AI 엔진 구동 계층. 현재 `acp`(Agent Client Protocol).
- **게이트(gate)**: 모든 권한 요청을 채널 승인으로 라우팅. 타임아웃·오류 시 기본 거부(fail-closed).

## 레인 설정

레인은 **파일 1개 = 레인 1개**입니다. `~/.config/adde/<proj>/lanes.d/<lane>.conf` 에 작성합니다.

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

- **telegram**: `chat_id=<회신 대상>`. 봇 토큰은 conf 가 아니라 `~/.config/adde/<proj>/state/<lane>/.env` 에 `TELEGRAM_BOT_TOKEN=...` 으로 둡니다(인자·로그 비노출).
- **markdown**: `root=<절대경로, 예: Obsidian vault>`, `inbox=<root 상대>`, (선택) `approvals=`·`outbox=`. → [마크다운 가이드](markdown.md).

## 기동·종료

```bash
adde up <proj>     # lanes.d 의 모든 레인 기동
adde down <proj>   # 레인 종료
adde --version
```

## 프로젝트 폴더 매핑

각 레인의 `cwd` 가 그 레인 AI 의 작업 디렉터리입니다. 레인마다 다른 `cwd` 를 지정하면 **채널/메모와 프로젝트 폴더를 각각 묶어** 여러 개를 동시에 운용할 수 있습니다. conf 를 여러 개 두면 `adde up` 한 번으로 모두 기동됩니다.

## 다음 단계

- 마크다운 노트(예: Obsidian)로 메모 기반 구동: [markdown.md](markdown.md)
- 문서 인덱스: [README.md](README.md)
