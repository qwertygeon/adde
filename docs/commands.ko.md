_[English](commands.md) | 한국어_

# 명령 레퍼런스

ADDE CLI(v2)의 전체 명령·옵션. 단일 진입점은 `adde`. 짧은 별칭(`ad`, `add`)은 기본 설치되지 않으며 `adde init` 또는 `adde alias` 로 옵트인합니다.

> **v0.2.x 명령 제거됨**: `lane`·`sessions`·`proj` 는 더 이상 유효한 최상위 명령이 아닙니다. 실행하면 조용히 실패하는 대신 "제거됨 — 대체 명령" 안내를 출력하고 exit 2 를 반환합니다. [v0.2.x 에서 이전](#v02x-에서-이전) 참조.

## 목차

- [전역 옵션](#전역-옵션)
- [개념 요약](#개념-요약)
- [init — 온보딩 마법사](#init--온보딩-마법사)
- [alias — 짧은 별칭 설치](#alias--짧은-별칭-설치)
- [up / down / restart — 데몬 제어](#up--down--restart--데몬-제어)
- [status — 세션 상태](#status--세션-상태)
- [doctor — 환경 점검](#doctor--환경-점검)
- [logs — 세션 이벤트 로그](#logs--세션-이벤트-로그)
- [project — 프로젝트 관리](#project--프로젝트-관리)
- [session — 세션 관리](#session--세션-관리)
- [bind — 채널 바인딩 관리](#bind--채널-바인딩-관리)
- [vault — vault 유지보수](#vault--vault-유지보수)
- [세션 제어(마크다운 팔레트)](#세션-제어마크다운-팔레트)
- [completion — 셸 자동완성](#completion--셸-자동완성)
- [도움말·오타 안내](#도움말오타-안내)
- [종료 코드](#종료-코드)
- [언어(로케일)](#언어로케일)
- [경로](#경로)
- [macOS 전용 기능](#macos-전용-기능)
- [v0.2.x 에서 이전](#v02x-에서-이전)

## 전역 옵션

| 옵션              | 설명        |
| ----------------- | ----------- |
| `-v`, `--version` | 버전 출력   |
| `-h`, `--help`    | 도움말 출력 |

인자 없이 `adde` 실행, 또는 `-h`/`--help`/`help` 는 전체 usage 를 출력합니다. 특정 명령의 도움말은 `adde <command> --help`(예: `adde status --help`, `adde project --help` 로 모든 `project` 하위명령 옵션 확인).

**머신 판독 출력(`--json`)**: `--json` 을 지원하는 명령은 stdout 에 최상위 스키마 버전 필드 `v`(현재 `1`)를 포함한 단일 JSON 문서를 출력합니다.

## 개념 요약

- **프로젝트**: vault 루트 하나와 (선택) 작업 디렉터리를 가진 최상위 단위. 세션을 N개 보유.
- **세션**: 자체 식별자·엔진·수명 상태(`active`/`hibernated`/`detached`/`archived`)를 가진 대화 단위.
- **바인딩**: 채널 주소(예: 마크다운 입력 노트 경로)와 세션의 연결.
- **vault**: 대화가 노트로 축적되는 마크다운 저장소 루트(프로젝트 생성 시 필수 지정).

전체 모델은 [시작하기](getting-started.ko.md#핵심-개념) 참조.

## init — 온보딩 마법사

```bash
adde init [<proj>]
```

`doctor` 실행 → 짧은 별칭 설치 여부 → 셸 자동완성 설정 여부 → 프로젝트 이름과 필수 `--vault` 경로(및 선택적으로 작업 디렉터리·권한 설정)를 대화형으로 물어 첫 프로젝트를 생성하는 마법사입니다(**TTY 전용**). 마지막에 데몬 시작 힌트(`adde up <proj>`)를 출력합니다.

## alias — 짧은 별칭 설치

```bash
adde alias [names...]
```

PATH 상의 `adde` 실행 파일 옆에 짧은 별칭 심링크를 설치합니다(기본 `ad`, `add`). 같은 이름의 기존 명령이 있으면 덮어쓰지 않고 건너뛰며 실패로 보고됩니다. 멱등 — 이미 `adde` 를 가리키는 심링크는 "이미 설정됨"으로 보고됩니다.

## up / down / restart — 데몬 제어

```bash
adde up <proj> [--json]
adde down <proj> [--json]
adde restart <proj> [--json]
```

**프로젝트당 데몬 1개**(세션당이 아님)를 **macOS launchd LaunchAgent** 로 시작/중지/재시작합니다. 한 프로젝트의 모든 세션은 이 단일 데몬 프로세스 안에서 동작하며, `up` 은 데몬을 기동하면서 저장된 엔진 재개 핸들로 `active` 였던 **모든 세션을 자동 재개**합니다(재개 실패 세션은 조용히 새 세션으로 대체되지 않고 사유와 함께 `detached` 로 표기됩니다).

- **터미널 독립**: 터미널을 닫아도 데몬은 계속 실행됩니다.
- **크래시 전용 자동 재기동**: launchd 가 크래시 시 데몬을 재기동하며(최소 60초 간격 제한), macOS 재부팅·로그아웃 후에는 항상 재기동됩니다(`RunAtLoad`). 의도적 종료(`adde down`)나 결정적 부팅 실패는 정상 종료되며 자동 재시도되지 않습니다. `auto_restart` 키로 편집 가능(`adde project set <proj> auto_restart false`) — [크래시 안전성](troubleshooting.ko.md#크래시-안전성--로그-회전) 참조.
- **`restart`** 는 `down` 후 `up` 을 수행하며, 데몬이 현재 코드를 메모리에 유지하므로 새 `adde` 버전과 `project set` 설정 변경을 적용하는 방법입니다.
- **기동 결과**: 등록 후 `up`/`restart` 는 데몬이 부팅 리포트를 기록할 때까지 대기해 요약(`N running · M failed`)을 출력합니다 — 기동에 실패한 세션은 사유와 함께 나열되고 명령은 0이 아닌 코드로 종료됩니다. 느린 머신에서는 `ADDE_UP_WAIT_MS` 환경변수(밀리초, 기본 `8000`)로 대기 상한을 늘릴 수 있습니다 — **양수** 정수만 유효하며, 비숫자·0·음수 값은 조용히 기본값으로 폴백됩니다.
- **`--json`**: 텍스트 요약 대신 부팅 결과를 출력합니다(스키마는 아래 [`status`](#status--세션-상태) 참조 — `up`/`restart` 는 같은 세션별 구조로 보고).
- **macOS 전용** — [macOS 전용 기능](#macos-전용-기능) 참조.

```bash
adde up myproj --json      # 머신 판독 부팅 결과
adde restart myproj        # 프로젝트 설정 변경 또는 새 adde 버전 적용
```

## status — 세션 상태

```bash
adde status [<proj>] [--all] [--json]
```

| 상태         | 의미                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `active`     | 엔진 프로세스 상주, 턴 수신 준비됨                                                                |
| `hibernated` | 세션은 살아있고 엔진 프로세스는 비상주(유휴 시간 초과 또는 상주 상한) — 다음 턴에서 투명하게 재개 |
| `detached`   | 재개 실패, 또는 반복 크래시 후 엔진 자가 재기동 포기 — 사유 기록됨                                |
| `archived`   | 보존 종료, 더 이상 활성 아님(`session clear` 의 승계 또는 `--purge` 없는 `session rm` 로 생성)    |

- **`<proj>` 지정 시**: `SID · STATUS · ENGINE · PRESENT · TITLE · LAST_ACTIVITY` 표.
- **`<proj>` 생략 시**: 등록된 전 프로젝트 집계, `PROJECT · SID · STATUS · ENGINE · PRESENT · LAST_ACTIVITY` 표.
- **`--all`**: `archived` 세션도 포함(기본은 제외).
- **`--json`**: `{ "v": 1, "sessions": [...], "halt": ... }` — `halt` 는 크래시루프 자가 정지 기록(단일 `<proj>` 뷰는 `HaltRecord | null`, 집계 뷰는 프로젝트별 맵). [크래시 안전성·로그 회전](troubleshooting.ko.md#크래시-안전성--로그-회전) 참조.
- `detached` 세션이 있거나 데몬이 크래시루프로 자가 정지했으면 stderr 에 경고+대응 안내가 출력되고 `status` 는 0이 아닌 코드로 종료합니다.
- 읽기 전용.

```bash
adde status myproj            # 한 프로젝트의 세션별 표
adde status --all             # 전 프로젝트, archived 세션 포함
adde status myproj --json     # 머신 판독 {v, sessions, halt}
```

## doctor — 환경 점검

```bash
adde doctor [<proj>] [--json]
```

런타임 상태와 무관한 정적 점검을 수행하며 각 항목을 `PASS`/`WARN`/`FAIL`/`INFO` 로 보고하고 실패·경고 시 대응 힌트를 붙입니다.

- **전역**: Node 버전(≥22) · 등록된 엔진 드라이버(`ENGINE_REGISTRY`) · 등록된 서페이스(`SURFACE_REGISTRY`, `telegram`/`discord` 는 stub 으로 표시) · (macOS) 데몬 진입 파일 해소 · OS 점검(macOS 아니면 `FAIL` — macOS 만 지원).
- **v0.2.x 데이터 존재**(`INFO`): 구 `~/.config/adde/<proj>/lanes.d/` 레이아웃이 발견되면 안내 목적으로만 보고됩니다 — 읽거나 변경하지 않습니다. v0.2.x 프로젝트 이름이 하필 `projects` 였던 이름 충돌은 설명과 함께 `FAIL` 로 보고됩니다(v2 가 그 이름을 프로젝트 컨테이너로 예약) — 어느 경우든 구 데이터는 변경되지 않습니다.
- **크래시루프 자가 정지**(`FAIL`, `<proj>` 지정 시): 프로젝트 데몬이 자가 정지했으면 `adde up`/`adde restart` 로 초기화하라는 안내와 함께 보고됩니다.
- `<proj>` 지정 시: launchd 등록 상태 상호 대조(plist vs `launchctl`) · `project.conf` 읽기 가능 여부 · 설정된 엔진 유효성 · vault 경로 존재(부재 시 최초 사용 시 생성됨 — `FAIL` 아닌 `WARN`).
- **`--json`**: `{ "v": 1, "checks": [...] }`. 요약 줄과 업데이트 안내를 생략합니다.
- 종료 코드: `FAIL` 존재 시 1, 아니면 0.

```bash
adde doctor myproj --json   # 머신 판독 점검 목록(CI/모니터링)
```

## logs — 세션 이벤트 로그

```bash
adde logs <proj> <session> [N] [--engine] [--daemon] [-f|--follow] [--json]
```

세션의 **대화 이벤트 기록**(vault 내 `.adde/sessions/<sid>/events-NNNN.jsonl`)을 사람이 읽을 수 있게 렌더한 결과 중 최근 `N` 줄(기본 50)을 출력합니다.

- `N`: 출력할 마지막 줄 수(기본 50); 양의 정수가 아니면 경고와 함께 50으로 폴백.
- `--engine`: 대신 세션의 **엔진 진단 로그**를 출력합니다(설정 루트 `runtime/sessions/<sid>/engine.log` — 대화 이벤트 기록과 달리 크기 기반 회전 허용).
- `--daemon`: 프로젝트의 **launchd 데몬 로그**를 출력합니다 — 이 형태는 `<session>` 이 불필요합니다.
- `-f`/`--follow`: 라이브 tail(`tail -f` 유사), 로그 회전·truncate 를 투명하게 따라감; `Ctrl-C` 로 정지. `--daemon` 과는 함께 쓸 수 없습니다.
- `--json`: `{ "v": 1, "proj", "sid", "path", "exists", "lines" }` 스냅샷(`--follow` 보다 우선).

```bash
adde logs myproj a1b2c3d4 100 --engine   # 엔진 진단 로그 최근 100줄
adde logs myproj --daemon                 # 데몬 로그(데몬/세션 부팅 실패 원인)
adde logs myproj a1b2c3d4 -f              # 대화 이벤트 기록 라이브 tail
```

## project — 프로젝트 관리

```bash
adde project add <proj> --vault <path> [options]              # 생성(vault 경로 필수)
adde project set <proj> <key> <value>... [--unset <key>...]   # 설정 편집
adde project show <proj> [key] [--json] [--defaults]          # 설정 조회
adde project ls [--json]                                      # 프로젝트 목록
adde project rm <proj> --force                                 # 삭제(설정 루트만 — vault 데이터 보존)
```

프로젝트 생성은 **`--vault <path>` 가 필수**입니다 — ADDE 는 임의의 기본 저장 위치를 만들지 않습니다. `--cwd` 는 이 프로젝트의 세션들이 엔진이 작업할 디렉터리입니다(선택 — 생략하면 엔진 자신의 프로세스 cwd 기준으로 동작).

### `project add` 옵션

| 옵션                              | 기본값                          | 설명                                                                                             |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--vault <path>`                  | (필수)                          | 마크다운 vault 루트                                                                              |
| `--cwd <path>`                    | (없음)                          | 엔진 작업 디렉터리                                                                               |
| `--engine <id>`                   | `acp`                           | 등록된 엔진 드라이버 id(`adde doctor` 로 목록 확인)                                              |
| `--perm-tier <acp\|autopass>`     | `acp`                           | 권한 티어 — [권한 가이드](permissions.ko.md) 참조                                                |
| `--allowlist <a,b,c>`             | (없음)                          | `acp` 티어에서 자동 허용할 도구                                                                  |
| `--denylist <entries,...>`        | 내장 기본 목록(`autopass` 전용) | `autopass` 에서 채널 승인으로 되돌릴 도구/패턴                                                   |
| `--hard-deny <entries,...>`       | (없음)                          | 티어 무관 즉시 거부할 도구/패턴                                                                  |
| `--safe-defaults`                 | —                               | 내장 위험 목록으로 hard-deny 채움(명시 `--hard-deny` 와 합집합)                                  |
| `--backup <path>`                 | (없음)                          | 보관 이관(경량화) 목적지 — [마크다운 가이드](markdown.ko.md#vault-경량화-보관-이관--동기화) 참조 |
| `--retention-days <n>`            | `2`                             | 턴 노트가 보관 이관되기까지의 나이(일)                                                           |
| `--sync-provider <local\|icloud>` | `local`                         | vault 동기화 제공자 — `icloud` 는 미다운로드 파일을 보관 이관 전 대기                            |

`--denylist` 없이 `--perm-tier autopass` 를 선택하면 내장 기본 거부 목록을 시드하고 다음 안내를 출력합니다:

```
autopass 티어에 거부 목록이 지정되지 않아 내장 기본 거부 목록 <N>건을 시드했습니다.
```

### `project set` — 설정 편집

```bash
adde project set <proj> <key> <value>...              # positional dot-notation 편집, 1개 이상 쌍
adde project set <proj> --unset <key>...               # 키 제거(기본값 복원)
adde project set <proj> --add-allow <a,b,c> --rm-deny <x,y>   # 증분 목록 편집
```

편집 가능한 키(단일 정의 — `adde project set`/`show`/자동완성이 모두 여기서 파생):

`cwd`, `engine`, `engine_args`, `perm_tier`, `allowlist`, `denylist`, `hard_deny`, `gate_timeout_sec`, `lang`, `file_mode`, `auto_restart`, `auto_resume`, `idle_hibernate`, `hibernate_after_min`, `max_active_engines`, `auto_relaunch`, `markdown.palette`, `markdown.records_cap`, `vault.backup`, `vault.retention_days`, `vault.sync_provider`.

`vault` 자체는 편집 불가(identity 필드, `project add` 시 1회 지정). 편집 배치는 **전부-아니면-전무** — 알 수 없는 키나 잘못된 값이 있으면 명령 전체를 거부하고 아무것도 쓰지 않습니다.

**증분 목록 편집**: `--add-allow`/`--rm-allow`, `--add-deny`/`--rm-deny`, `--add-hard-deny`/`--rm-hard-deny` 는 현재 목록에 병합·차감합니다(positional `allowlist`/`denylist`/`hard_deny <value>` 형태는 전체 교체). 편집 적용에는 `adde restart <proj>` 가 필요합니다 — 데몬은 기동 시점에만 프로젝트 설정을 읽습니다.

### `project show` / `project ls` / `project rm`

```bash
adde project show myproj                       # 전체 설정 덤프
adde project show myproj perm_tier --json      # 한 키의 값/기본값/명시여부
adde project show myproj --defaults             # 편집 가능한 전 키와 내장 기본값
adde project ls --json                          # { v, projects: [...] }
adde project rm myproj --force                  # 설정 루트만 삭제 — vault(대화 데이터) 보존
```

`project rm` 은 **설정 루트**(`~/.config/adde/projects/<proj>/`) — 설정·세션 레코드·런타임 상태만 삭제합니다. **vault 데이터(이벤트·노트·blob·중복 판정 원장)는 절대 건드리지 않습니다** — 같은 vault 경로로 `project add` 를 다시 실행하면 이력이 그대로 복구됩니다.

## session — 세션 관리

```bash
adde session new <proj> [--engine <id>] [--title <t>] [--engine-args <args>] [--json]
adde session ls <proj> [--json]
adde session show <proj> <sid> [--json]
adde session clear <proj> <sid>     # 승계 — 새 세션 생성, 기존 세션은 archived
adde session rm <proj> <sid> [--purge] [--force]
```

`session clear` 는 **절대 삭제하지 않습니다** — 새 세션을 만들고 기존 세션의 바인딩을 새 세션으로 옮긴 뒤 기존 세션을 `archived` 로 표시합니다. 실제 삭제는 `session rm` 으로만 일어나며, `--purge` 없이는 세션 레코드만 제거됩니다(vault 노트는 무손실 원본이므로 건드리지 않음); `--purge` 는 파괴적이라 확인(또는 `--force`)이 필요합니다.

```bash
adde session new myproj --title "frontend work"
adde session ls myproj --json
adde session clear myproj a1b2c3d4        # 승계, 삭제 아님
```

## bind — 채널 바인딩 관리

```bash
adde bind add <proj> <sid> --surface <id> --address <addr>
adde bind rm <proj> <sid> --surface <id> --address <addr>
adde bind ls <proj> [--json]
```

`--surface` 는 등록된 서페이스 중 하나입니다(`markdown` 구현됨; `telegram`/`discord` 는 등재만 되고 **stub — 바인딩 생성은 거부**). `markdown` 의 `--address` 는 vault 내 세션의 입력 노트 경로입니다. 기본 markdown 서페이스의 바인딩은 `project`/`session` 생성 시 자동으로 만들어지므로, `bind` 는 주로 조회(`bind ls`)나 **추가** 바인딩 생성에 씁니다.

## vault — vault 유지보수

```bash
adde vault rebuild <proj> [--sid <sid>] [--json]
```

프로젝트(또는 `--sid` 지정 시 세션 하나)의 마크다운 노트와 중복 판정 원장을 **오직 대화 이벤트 기록만으로** 재생성합니다 — 기록만이 원본이며 노트·blob 참조·중복 판정 결과는 전부 파생물이라 삭제해도 안전합니다. 같은 기록에 몇 번을 실행해도 결과가 같습니다(멱등). 노트 트리를 실수로 지웠거나 손상됐을 때, 또는 노트를 옮긴 뒤 복구할 때 사용합니다.

```bash
adde vault rebuild myproj              # 모든 세션의 노트 재생성
adde vault rebuild myproj --sid a1b2c3d4 --json
```

## 세션 제어(마크다운 팔레트)

세션 초기화·압축·재개는 CLI 가 아니라 **채널에서** 지시합니다 — 각 세션 입력 노트 상단에 상주하는 체크박스 팔레트(`markdown.palette`, 기본 켬):

| 마커               | 동작   | 결과                                                             |
| ------------------ | ------ | ---------------------------------------------------------------- |
| `- [ ] 🗄️ archive` | 정리   | 기록 존의 완료된 전송 마커를 요약 한 줄로 접음                   |
| `- [ ] 🧹 clear`   | 초기화 | 새 세션 시작(승계 — [`session clear`](#session--세션-관리) 참조) |
| `- [ ] 🗜️ compact` | 압축   | 엔진 자체 압축 명령 실행(`caps.compact !== "none"` 일 때만 렌더) |
| `- [ ] ♻️ resume`  | 재개   | `detached`/`hibernated` 세션 재개 재시도                         |

마커를 체크하면 1회 실행되고 제자리에서 미체크로 복원됩니다 — 상주 컨트롤이지 1회성 메시지가 아닙니다. 3존 레이아웃 전체는 [마크다운 가이드](markdown.ko.md#3-지시-보내기입력-노트) 참조. 본 릴리스에서 Telegram/Discord 는 미구현(stub) 이라 채팅 명령 대응물이 아직 없습니다.

## completion — 셸 자동완성

```bash
adde completion <bash|zsh>
```

command/flag 자동완성 스크립트를 stdout 에 출력합니다(설치는 하지 않음). 최상위 명령, `project`/`session`/`bind`/`vault` 하위명령과 그 플래그, enum 플래그 값(`--perm-tier`, `--file-mode`, `--lang`, `--sync-provider`, `--surface`), 디렉터리 경로(`--cwd`/`--vault`/`--backup`), 그리고 설정 루트에서 실시간 스캔한 프로젝트·세션 이름을 완성합니다. `project set` 편집 가능 키는 해당 위치에서 완성되며, 프로젝트/세션 이름 완성은 명령·하위명령·프로젝트 이름까지만 지원합니다(v0.1.x 대비 설정 키·플래그 enum 값 완성 범위 축소).

```bash
adde completion zsh > "${fpath[1]}/_adde"
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

## 도움말·오타 안내

- `adde <command> --help` 는 해당 명령의 usage 를 출력하고 exit 0.
- 지원하지 않는 명령은 `Unknown command` + 가장 가까운 명령 추측을 stderr 에 출력하고 exit 1.
- 지원하지 않는 플래그 또는 필수 인자 누락은 오류 + usage 를 stderr 에 출력하고 exit **2**.

## 종료 코드

- **0**: 성공(`--help`/`--version` 포함).
- **2**: 호출 자체가 잘못됨 — 지원하지 않는 플래그, 잘못된/누락된 플래그 값, 필수 인자 누락.
- **1**: 성공이 아닌 나머지 — 운영 실패, 지원하지 않는 명령/하위명령, `status` 가 보고하는 `detached` 세션이나 크래시루프 정지, `doctor` 의 `FAIL` 항목.

## 언어(로케일)

- **결정 순서**: `ADDE_LANG`(명시) > `LC_ALL` > `LC_MESSAGES` > `LANG`(`ko*` → 한국어) > 기본 영어.
- **프로젝트별 채널 언어**: `adde project set <proj> lang <en|ko>` 로 해당 프로젝트 채널 메시지(권한 프롬프트·통지)의 언어를 고정합니다. 미지정 시 데몬의 전역 로케일을 따릅니다.

## 경로

- 설정 루트: `~/.config/adde`(`ADDE_HOME` 로 재정의).
- 프로젝트 설정: `<설정루트>/projects/<proj>/{project.conf, sessions.d/<sid>.json, .env, runtime/{runtime.json, engines.json, retention-last-run, control/, sessions/<sid>/{queue, processing, engine.log}}}`.
- vault(`project add --vault` 지정): `<vault>/adde/projects/<proj>/{project.md, sessions/<sid>/{session.md, inbox.md, approvals/<permId>.md, turns/<NNNN ts>.md}, .adde/{sessions/<sid>/{events-NNNN.jsonl, gen-NNNN.summary.json}, blobs/<aa>/<sha256>, ledger/dedup.jsonl}}`.
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist`(macOS 전용).

설정·시크릿·런타임 상태는 설정 루트에, 대화 데이터(이벤트·노트·첨부·중복 판정)는 지정한 vault 에만 있습니다.

## macOS 전용 기능

`adde up`/`down`/`restart` 는 macOS launchd 에 의존합니다. 다른 OS 에서는 이 명령들이 오류를 반환합니다(현재 범위 밖).

**재부팅 자동복구**: `adde up` 으로 등록된 데몬은 macOS 재부팅·로그아웃 후 항상 재기동되며(`RunAtLoad`), `active` 였던 모든 세션이 자동 재개됩니다. 크래시 자동 재기동(`KeepAlive`)은 별개이며 제한이 걸려 있습니다 — [`project.conf` auto_restart](#project--프로젝트-관리)·[크래시 안전성](troubleshooting.ko.md#크래시-안전성--로그-회전) 참조.

## v0.2.x 에서 이전

- `lane add/set/ls/show/rm` → `project add/set/show/ls/rm`(프로젝트 수준 설정) + `session new/ls/show/clear/rm`(대화별) + `bind add/rm/ls`(채널↔세션 연결).
- `sessions <proj> <lane>` → `session ls <proj>`.
- `proj ls/rm` → `project ls/rm`.
- `~/.config/adde/<proj>/` 의 v0.2.x 설정·데이터는 v2 가 **읽지도 변경하지도 않습니다** — `adde doctor` 가 안내 목적으로만 존재를 보고합니다. v2 는 물리적으로 분리된 설정 루트(`~/.config/adde/projects/<proj>/`)를 씁니다.
