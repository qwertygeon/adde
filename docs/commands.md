# 명령 레퍼런스

ADDE CLI 의 전체 명령·옵션입니다. 주 진입점은 `adde`, 단축 별칭은 `add` 로 동일하게 동작합니다.

## 목차

- [전역 옵션](#전역-옵션)
- [up — 레인 기동 (데몬)](#up--레인-기동-데몬)
- [down — 레인 종료](#down--레인-종료)
- [restart — 레인 재기동](#restart--레인-재기동)
- [status — 레인 상태](#status--레인-상태)
- [doctor — 환경 점검](#doctor--환경-점검)
- [logs — 최근 활동](#logs--최근-활동)
- [lane — 레인 설정](#lane--레인-설정)
- [종료 코드](#종료-코드)
- [경로](#경로)
- [macOS 전용 기능](#macos-전용-기능)

## 전역 옵션

| 옵션 | 설명 |
|---|---|
| `-v`, `--version` | 버전 출력 |
| `-h`, `--help` | 도움말 출력 |

인자 없이 `adde` 를 실행하면 사용법을 출력합니다.

## up — 레인 기동 (데몬)

```bash
adde up <proj>
```

`~/.config/adde/<proj>/lanes.d/` 의 모든 `*.conf` 레인을 **macOS launchd LaunchAgent 데몬**으로 기동합니다. `adde up` 자체는 plist 등록 후 즉시 종료되고, 실제 레인은 백그라운드 데몬(`launchd` 관리)으로 상주합니다.

- **터미널 독립**: 터미널을 닫아도 데몬이 계속 동작합니다.
- **자동 복구**: macOS 재부팅·로그아웃 후에도 launchd가 자동으로 데몬을 재기동합니다.
- **중복 기동 가드**: 이미 실행 중인 레인은 경고 메시지와 조치 힌트를 출력하고 스킵합니다. 이중 기동은 발생하지 않습니다.
- **macOS 전용**: launchd 기능은 macOS에서만 동작합니다. 상세는 [macOS 전용 기능](#macos-전용-기능)을 참조하세요.

기동 시 plist 파일(`~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist`)이 생성되고 launchd에 등록됩니다. 각 레인의 상태는 `state/<lane>/runtime.json`에 기록됩니다.

## down — 레인 종료

```bash
adde down <proj>
```

해당 프로젝트의 launchd 데몬을 종료하고 plist 파일을 제거합니다. **어느 터미널에서든** 실행 가능합니다(교차 프로세스 종료).

## restart — 레인 재기동

```bash
adde restart <proj>
```

`down` 후 `up`을 순서대로 수행합니다. 설정 변경 후 데몬을 다시 기동하거나, 데몬 상태를 초기화할 때 사용합니다.

- `down` 성공 후 `up` 실패 시, `up` 오류를 표면화하고 종료 코드 1을 반환합니다.

## status — 레인 상태

```bash
adde status [<proj>] [--all] [--json]
```

`lanes.d` 의 각 레인을 스캔해 상태를 판정합니다.

| 상태 | 의미 |
|---|---|
| `running` | 상태 파일이 있고 기동 프로세스(pid)가 살아있으며 하트비트가 신선함 |
| `stale` | pid 는 살아있으나 하트비트(상태 파일 mtime)가 끊김 — **행(hung) 의심** |
| `dead` | 상태 파일이 있으나 프로세스가 없음 — **비정상 종료(크래시) 잔존** |
| `stopped` | 상태 파일 없음 — 정상 종료 또는 미기동 |

- **`<proj>` 지정**: 해당 프로젝트의 모든 레인(정지 포함)을 `LANE · STATUS · PID · UPTIME · SEEN · SOURCE` 표로 출력.
- **`<proj>` 생략**: 전 프로젝트(`~/.config/adde/*/`)를 집계해 **실행 중(정지 제외) 레인**을 `PROJECT · LANE · …` 표로 출력. 실행 중 레인이 없으면 안내 메시지.
- **`--all`**(`<proj>` 생략 시): 정지(`stopped`) 포함 전 레인을 표시.
- `dead`·`stale` 레인이 있으면 조치 안내를 덧붙입니다(`SEEN` = 마지막 하트비트 경과).
- 하트비트: `adde up` 이 주기적으로 상태 파일 mtime 을 갱신합니다. pid 가 살아있어도 갱신이 임계 시간 멈추면 `stale`(행) 로 판정합니다.
- `--json`: 레인 객체 배열(모니터링/스크립트용, `lastSeenAt` 포함; 집계 시 `proj` 부기).
- 읽기 전용(부수효과 없음).

## doctor — 환경 점검

```bash
adde doctor [<proj>]
```

상태와 무관한 정적 점검을 수행하고 각 항목을 `PASS` / `WARN` / `FAIL` 로 보고합니다. 실패·경고에는 조치 힌트(`↳ 조치:`)가 붙습니다.

- 전역: Node 버전(≥22) · ACP 어댑터 바이너리 해석 · 설정 base 디렉터리.
- `<proj>` 지정 시 레인별: source 유효성 · `cwd` 존재 · (telegram) `.env` 토큰 존재.
- `<proj>` 지정 시 macOS에서는 launchd 데몬 등록 상태도 점검합니다 — plist 존재 여부와 launchctl 등록 여부를 교차 확인하고, 불일치(plist는 있으나 launchd 미등록, 또는 그 역)를 `WARN`으로 표면화합니다.
- 읽기 전용. 기동 전 "왜 안 뜨나"를 자가 진단하는 용도입니다.

## logs — 최근 활동

```bash
adde logs <proj> <lane> [N] [--engine]
```

해당 레인의 `transcript.log`(ACP 세션 이벤트 기록) 최근 `N` 줄을 출력합니다(기본 50). 파일이 없으면 안내를 출력합니다.

- `--engine`: transcript 대신 `engine.log`(엔진 서브프로세스 stderr 캡처)를 출력합니다. 엔진 자체의 진단 출력을 볼 때 사용합니다(`stale`/기동 실패 원인 추적 등).

## lane — 레인 설정

레인 conf(`lanes.d/<lane>.conf`)를 생성·조회·삭제합니다. 파일 1개 = 레인 1개.

```bash
adde lane add <proj> <lane> [옵션]   # 생성
adde lane ls <proj>                  # 목록
adde lane show <proj> <lane>         # conf 출력
adde lane rm <proj> <lane>           # 삭제 (state/queue 등 부수 데이터는 보존)
adde lane help                       # 전체 옵션
```

### lane add 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--source <telegram\|markdown>` | `telegram` | 채널 소스 |
| `--engine <name>` | `claude-code-acp` | ACP 엔진 프로필 |
| `--backend <name>` | `acp` | 백엔드 |
| `--channel <name>` | source 값 | 게이트 분기 |
| `--perm-tier <tier>` | `acp` | 권한 티어 |
| `--acp-version <v>` | `v1` | ACP 버전 |
| `--cwd <abs-path>` | (supervisor cwd) | 이 레인 AI 의 작업 폴더(프로젝트 매핑) |
| `--allowlist <a,b,c>` | (없음) | 자동 허용 도구(게이트는 유지) |
| `--chat-id <id>` | (없음) | telegram 회신 대상 |
| `--token-stdin` | — | telegram 봇 토큰을 stdin 에서 읽어 `.env`(0600) 기록 |
| `--root <abs-path>` | (없음) | markdown 루트(예: Obsidian vault) |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | — | markdown 노트 경로(root 상대) |
| `--force` | — | 기존 conf 덮어쓰기 |
| `--interactive` | — | 대화형으로 필드 입력(TTY 전용, **토큰은 묻지 않음**) |

`--interactive` 는 대화형 터미널(TTY)에서만 동작합니다. 봇 토큰은 화면 노출을 피하기 위해 인터랙티브에서 받지 않으며, 생성 후 `--token-stdin` 또는 `.env` 직접 기록으로 설정합니다. 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상은 **경고**로 안내하되 생성은 진행됩니다.

## 종료 코드

| 명령 | 0 | 1 |
|---|---|---|
| `up` | 데몬 등록 성공 | launchd 등록 실패·인자 누락 |
| `down` | 데몬 종료 성공(이미 없어도 0) | 오류 발생 |
| `restart` | down+up 모두 성공 | down 또는 up 실패 |
| `status` | 모두 정상 | `dead`(크래시)·`stale`(행) 레인 존재 |
| `doctor` | FAIL 없음 | FAIL 항목 존재 |
| `logs` | 항상(파일 없어도 안내 후 0) | — |
| `lane *` | 성공 | 인자 누락·검증 오류 |

## 경로

- 설정 base: `~/.config/adde`(환경변수 `ADDE_HOME` 로 변경 가능).
- 프로젝트: `<base>/<proj>/`.
- 레인 conf: `<base>/<proj>/lanes.d/<lane>.conf`.
- 레인 상태: `<base>/<proj>/state/<lane>/`(`.env`·`session.id`·`transcript.log`·`engine.log`·`runtime.json`).
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist` (macOS 전용, `adde up` 이 생성·관리).

## macOS 전용 기능

`adde up`/`down`/`restart` 의 데몬 관리 기능은 macOS launchd에 의존합니다. Linux/WSL 환경에서는 이 명령들이 오류를 반환합니다.

**재부팅 자동복구**: `adde up` 으로 등록한 데몬은 macOS 재부팅·로그아웃 후에도 자동으로 재기동됩니다(`KeepAlive`/`RunAtLoad` 설정). 재부팅 후 `adde status <proj>` 로 복구를 직접 확인하는 것을 권장합니다.

**운영 검증 체크리스트**: 아래 항목은 자동 검증 범위 밖으로, 실 macOS 환경에서 직접 확인해야 합니다.

1. `adde up <proj>` → 터미널 종료 → 새 터미널에서 `adde status <proj>` 가 `running` 인지 확인
2. 다른 터미널에서 `adde down <proj>` 후 `adde status <proj>` 가 `stopped` 인지 확인
3. macOS 재부팅 후 `adde status <proj>` — 자동 복구 확인
4. `adde up <proj>` 연속 두 번 실행 — 이중 기동 없음 확인(경고 메시지 출력 후 스킵)
5. `adde down <proj>` 후 `ps aux | grep claude-code-acp` — orphan 프로세스 없음 확인
