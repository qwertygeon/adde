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
- [factory-reset — 전체 초기화](#factory-reset--전체-초기화)
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
- **세션**: 자체 식별자·엔진·수명 상태(`active`/`hibernated`/`stopped`/`detached`)를 가진 대화 단위.
- **바인딩**: 채널 주소(예: 마크다운 입력 노트 경로)와 세션의 연결.
- **vault**: 대화가 노트로 축적되는 마크다운 저장소 루트(프로젝트 생성 시 필수 지정).

신규 세션의 식별자는 사람이 목록에서 고를 수 있는 `YYMMDD-N` 형식입니다 — 생성 시점의 로컬 날짜 + 그날의 생성 순번(예: `260828-2`). 제목을 주면 `YYMMDD-N-<slug>`(예: `260828-3-refactor-queue`)가 되고, 안전 문자셋(`A-Za-z0-9_-`) 밖 문자만으로 된 제목은 slug 없이 부여됩니다. 이미 부여된 식별자는 **개명하지 않으므로** 기존 `<base36>-<8 hex>` 형식도 그대로 동작합니다. **식별자를 사전순으로 정렬하지 마세요** — 문자열로는 `260828-10` 이 `260828-2` 보다 앞섭니다. 모든 목록(`session ls`·재개 목록)은 마지막 활동 시각 기준으로 정렬합니다.

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
- **크래시 전용 자동 재기동**: launchd 가 크래시 시 데몬을 재기동하며(최소 60초 간격 제한), macOS 재부팅·로그아웃 후에는 항상 재기동됩니다(`RunAtLoad`). 의도적 종료(`adde down`)나 결정적 부팅 실패는 정상 종료되며 자동 재시도되지 않습니다. `auto_restart` 키로 편집 가능(`adde project set <proj> auto_restart false`) — [크래시 안전성](troubleshooting.ko.md#크래시-안전성로그-회전) 참조.
- **`restart`** 는 `down` 후 `up` 을 수행하며, 데몬이 현재 코드를 메모리에 유지하므로 새 `adde` 버전과 `project set` 설정 변경을 적용하는 방법입니다.
- **기동 결과**: 등록 후 `up`/`restart` 는 데몬이 부팅 리포트를 기록할 때까지 대기해 요약(`N running · M failed`)을 출력합니다 — 기동에 실패한 세션은 사유와 함께 나열되고 명령은 0이 아닌 코드로 종료됩니다. 느린 머신에서는 `ADDE_UP_WAIT_MS` 환경변수(밀리초, 기본 `8000`)로 대기 상한을 늘릴 수 있습니다 — **양수** 정수만 유효하며, 비숫자·0·음수 값은 조용히 기본값으로 폴백됩니다.
- **라이브니스 갱신 주기**: 상주하는 동안 데몬은 `ADDE_HEARTBEAT_INTERVAL_MS`(밀리초, 기본 `60000`) 주기로 라이브니스 기록을 갱신합니다 — **양수** 정수만 유효하며, 비숫자·0·음수 값은 기본값으로 폴백됩니다. 그 주기의 3배(기본 180초) 동안 갱신되지 않은 기록은 `status` 에서 "응답 없음"으로 보고됩니다(아래 참조).
- **부팅 안내**: 해소 대상이 아닌 부팅 시점 안내(현재: 실효 denylist 를 명시하는 `autopass` 티어 배너)가 요약 줄 바로 앞에 stderr 로 출력됩니다. 부팅 리포트의 `notices` 필드에도 함께 실리므로 `--json` 출력에도 나타납니다(추가 필드 — 스키마 버전 불변).
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

| 상태         | 감시      | 의미                                                                                                                                                                  |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`     | 함        | 엔진 프로세스 상주, 턴 수신 준비됨                                                                                                                                    |
| `hibernated` | 함        | 세션은 살아있고 엔진 프로세스는 비상주(유휴 시간 초과 또는 상주 상한) — 다음 턴에서 투명하게 재개                                                                     |
| `stopped`    | **안 함** | 사용자 또는 자동 중지로 감시가 종료된 상태. 입력 노트·승인 디렉터리를 어떤 주기로도 읽지 않으며, 명시적인 `session resume`(또는 팔레트의 `resume`)으로만 되살아납니다 |
| `detached`   | **안 함** | 재개 실패, 또는 반복 크래시 후 엔진 자가 재기동 포기 — 사유가 기록되고 재개 목록에 함께 표시됩니다                                                                    |

`stopped` 은 이전의 `archived` 상태를 대체합니다 — 승계(`session clear`)와 명시적 중지가 모두 `stopped` 으로 귀결되고, 레코드에 남아 있는 구 `archived` 값은 읽을 때 **중지로 해석**되며 파일을 고쳐 쓰지 않습니다(마이그레이션 명령 없음 — 실행할 것이 없습니다).

- **`<proj>` 지정 시**: `SID · STATUS · ENGINE · PRESENT · WARN · TITLE · LAST_ACTIVITY` 표 — 상태와 무관하게 그 프로젝트의 전 세션.
- **`<proj>` 생략 시**: 등록된 전 프로젝트 집계, `PROJECT · SID · STATUS · ENGINE · PRESENT · WARN · LAST_ACTIVITY` 표.
- **`WARN`**: 해당 세션에 기록된 경고 건수(없으면 `-`) — 저장 실패·재개 실패·중지 노트 교체 실패 등. 본문은 표에 싣지 않으며 `session show <proj> <session>` 으로 확인한다.
- **`--all`**: 집계 뷰에서 `stopped`·`detached` 세션까지 포함(기본은 `active`/`hibernated` 만).
- **데몬 상태 줄**: 표 아래 프로젝트별로 한 줄(`데몬 {{proj}}: {{state}}`)이 데몬의 실제 라이브니스를 보고합니다 — `상주 중`, `응답 없음`(프로세스는 살아있으나 주기 갱신이 끊김), `비정상 종료`(프로세스는 없으나 라이브니스 기록이 제거되지 않음), `미기동`(아직 켜지 않았거나 정상 종료됨 — 세션 자체의 `stopped` 상태와는 다른 표기), `판정 불가`(라이브니스 기록이 있으나 판독할 수 없어 상태를 알 수 없음) 중 하나입니다. 세션의 `PRESENT` 컬럼도 이 신호를 반영합니다(데몬이 `상주 중`이고 그 세션이 활성일 때만 있음으로 표시 — 더 이상 고정값이 아닙니다). `응답 없음`·`비정상 종료`·`판정 불가`와 크래시루프 자가 정지 기록에는 다음에 실행할 명령을 담은 조치 안내가 함께 표시됩니다.
- **`--json`**: `{ "v": 1, "sessions": [...], "halt": ..., "daemon": ..., "haltUnreadable": ... }` — 추가 필드이며 스키마 버전은 불변입니다. `sessions` 는 표시 필터(`--all`) 적용 전 전체 집합을 담습니다. `halt` 는 기존 형태를 그대로 유지합니다(단일 `<proj>` 뷰는 `HaltRecord | null`, 집계 뷰는 프로젝트별 맵 — [크래시 안전성·로그 회전](troubleshooting.ko.md#크래시-안전성로그-회전) 참조). `haltUnreadable` 은 자가 정지 기록이 있으나 판독할 수 없는 경우를 추가로 보고합니다(단일 뷰는 `string | null`, 집계 뷰는 해당하는 프로젝트만 담는 맵). `daemon` 은 프로젝트별로 위와 동일한 5상태 라이브니스를 담습니다.
- 다음 중 하나라도 해당하면 stderr 에 조치 안내를 동반한 경고가 출력되고 `status` 는 0이 아닌 코드로 종료합니다 — 판정은 **`<proj>`/`--all` 표시 필터와 무관하게 등록된 전체 프로젝트 기준**입니다: `detached` 세션 존재, 크래시루프 자가 정지 기록 존재, 데몬이 `응답 없음`·`비정상 종료`, 또는 라이브니스·자가 정지 기록이 판독 불가(상태를 알 수 없음). 데몬이 단순히 `미기동`인 것만으로는 실패가 아닙니다.
- 읽기 전용.

```bash
adde status myproj            # 한 프로젝트의 세션별 표
adde status --all             # 전 프로젝트, stopped·detached 세션 포함
adde status myproj --json     # 머신 판독 {v, sessions, halt, daemon, haltUnreadable}
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
- **텍스트 모드**는 마지막에 등급(`PASS`/`WARN`/`FAIL`/`INFO`)별 건수를 담은 요약 줄을 출력합니다.
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

**경로 설정은 절대경로여야 합니다.** `vault`·`vault.backup`·`cwd` 는 절대경로로 읽고, 앞의 `~/` 는 홈 디렉터리로 확장합니다. 상대경로는 설정을 읽는 시점에 거부되므로, 값을 고칠 때까지 그 프로젝트의 모든 명령과 데몬 기동이 설정 오류로 실패합니다(명령을 어디서 실행했는지에 따라 경로가 달라지면 파괴적 동작이 의도하지 않은 곳을 향할 수 있기 때문입니다). 셸은 보통 `~` 를 ADDE 에 넘기기 전에 펼치므로, 리터럴 `~` 는 따옴표로 감쌌거나(`--vault '~/Vault'`) 설정 파일을 직접 편집한 경우에만 남습니다. `project add` 는 이 값을 생성 시점에 검사하지 않으므로 상대경로로 만든 프로젝트는 생성 직후부터 읽히지 않습니다 — 그 경우 설정 파일의 값을 절대경로로 고치세요([문제 해결](troubleshooting.ko.md) 참조).

### `project add` 옵션

| 옵션                              | 기본값                          | 설명                                                                                           |
| --------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--vault <path>`                  | (필수)                          | 마크다운 vault 루트                                                                            |
| `--cwd <path>`                    | (없음)                          | 엔진 작업 디렉터리                                                                             |
| `--engine <id>`                   | `acp`                           | 등록된 엔진 드라이버 id(`adde doctor` 로 목록 확인)                                            |
| `--perm-tier <acp\|autopass>`     | `acp`                           | 권한 티어 — [권한 가이드](permissions.ko.md) 참조                                              |
| `--allowlist <a,b,c>`             | (없음)                          | `acp` 티어에서 자동 허용할 도구                                                                |
| `--denylist <entries,...>`        | 내장 기본 목록(`autopass` 전용) | `autopass` 에서 채널 승인으로 되돌릴 도구/패턴                                                 |
| `--hard-deny <entries,...>`       | (없음)                          | 티어 무관 즉시 거부할 도구/패턴                                                                |
| `--safe-defaults`                 | —                               | 내장 위험 목록으로 hard-deny 채움(명시 `--hard-deny` 와 합집합)                                |
| `--backup <path>`                 | (없음)                          | 보관 이관(경량화) 목적지 — [마크다운 가이드](markdown.ko.md#vault-경량화-보관-이관동기화) 참조 |
| `--retention-days <n>`            | `2`                             | 턴 노트가 보관 이관되기까지의 나이(일)                                                         |
| `--sync-provider <local\|icloud>` | `local`                         | vault 동기화 제공자 — `icloud` 는 미다운로드 파일을 보관 이관 전 대기                          |

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

`cwd`, `engine`, `engine_args`, `perm_tier`, `allowlist`, `denylist`, `hard_deny`, `gate_timeout_sec`, `lang`, `file_mode`, `auto_restart`, `auto_resume`, `idle_hibernate`, `hibernate_after_min`, `idle_stop`, `stop_after_min`, `max_active_engines`, `auto_relaunch`, `markdown.palette`, `markdown.records_cap`, `markdown.notices_cap`, `vault.backup`, `vault.retention_days`, `vault.sync_provider`.

이 중 세 키는 본 릴리스에서 신설됐습니다:

| 키                     | 기본값 | 의미                                                                                            |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `idle_stop`            | `true` | 장기 무활동 세션의 자동 중지. **기본 켬** — `false` 로 두면 옵트아웃되어 수동 중지만 일어납니다 |
| `stop_after_min`       | `60`   | 마지막 활동 이후 자동 중지까지의 시간(분)                                                       |
| `markdown.notices_cap` | `10`   | 입력 노트가 유지하는 안내 건수 상한(초과분은 오래된 것부터 제거). **`0` 은 무제한**             |

```bash
adde project set myproj idle_stop false            # 자동 중지 옵트아웃
adde project set myproj stop_after_min 180          # 무활동 3시간 후 자동 중지
adde project set myproj markdown.notices_cap 0      # 안내 상한 없음(전부 유지)
```

`stop_after_min` 과 `hibernate_after_min` 은 둘 다 세션의 **마지막 활동** 이후 경과 시간을 기준으로 합니다(유휴로 내려간 시점이 아닙니다). `stop_after_min` 이 `hibernate_after_min` 보다 작거나 같으면 세션은 `hibernated` 를 거치지 않고 `active` 에서 곧바로 `stopped` 이 됩니다. 상주 엔진 상한(`max_active_engines`) 초과로 내려가는 세션은 여전히 유휴로만 내려가며 중지되지 않습니다.

`vault` 자체는 편집 불가(identity 필드, `project add` 시 1회 지정). 편집 배치는 **전부-아니면-전무** — 알 수 없는 키나 잘못된 값이 있으면 명령 전체를 거부하고 아무것도 쓰지 않습니다. 설정 파일을 직접 편집해 쓸 수 없는 값(음수 `markdown.notices_cap`·비정수 `stop_after_min`)이 들어가면 그 키는 잘못된 값이 조용히 수락되는 대신 내장 기본값으로 폴백합니다.

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
adde session clear <proj> <sid>              # 승계 — 현재 세션을 중지하고 새 세션 생성
adde session stop <proj> <sid> [--json]      # 세션 감시 종료
adde session resume <proj> [<sid>] [--json]  # 중지·떨어진 세션 되살리기
adde session rm <proj> <sid> [--purge]       # 제거(대화형 3분기)
```

`session ls` 는 **레코드 뷰** 입니다 — 설정 루트의 세션 레코드만 읽으므로 데몬 기동 여부와 무관하게 동작합니다(엔진 실제 상주 여부는 `adde status`). 행은 마지막 활동 최신순으로 정렬되며 식별자·상태·엔진·제목(없으면 `-`)·마지막 활동 시각을 함께 보여줍니다.

`session clear` 는 **절대 삭제하지 않습니다** — 현재 세션을 중지하고 새 세션을 만들어 바인딩을 옮긴 뒤 두 세션을 양방향으로 연결합니다: 새 세션 노트에는 이전 세션 링크가, 중지된 세션 노트에는 승계된 새 세션 링크가 남습니다. 두 노트 모두 vault 에 그대로 보존됩니다.

```bash
adde session new myproj --title "frontend work"
adde session ls myproj --json
adde session clear myproj 260828-2        # 승계, 삭제 아님
```

### `session stop` / `session resume`

```bash
adde session stop myproj 260828-2       # 이 세션의 감시 종료
adde session resume myproj 260828-2     # 다시 감시 시작
adde session resume myproj              # 재개 가능한 세션이 몇 건인지만 확인
```

`stop` 은 감시를 끝냅니다 — 세션의 엔진이 내려가고 입력 노트·승인 디렉터리를 **어떤 주기로도 읽지 않습니다**. 진행 중인 턴, 큐에 남은 봉투, 미소비 전송 체크박스처럼 잔여 작업이 있으면 즉시 중지하지 않고 **예약** 합니다 — 예약 사실을 안내로 남기고, 잔여 작업이 소진되면 실제로 중지하며 완료 안내를 한 번 더 남깁니다. 예약은 데몬 재기동을 건너 유지되며, 유지할 수 없으면 그 사실을 안내로 표면화합니다(조용한 소실 없음).

`resume` 은 `stopped`·`detached` 세션을 `active` 로 되돌리고 입력 노트를 정상 레이아웃으로 복구합니다(남겨 둔 초안은 그대로 보존). `<sid>` 없이 호출하면 재개 대상 건수만 알려주고 `session ls` 를 안내합니다 — 선택 목록을 CLI 에 만들지 않습니다(선택 목록은 입력 노트에 있습니다, [세션 제어](#세션-제어마크다운-팔레트) 참조).

- 두 명령은 상태 불일치를 정직하게 알립니다: 이미 중지된 세션에 중지, `stopped`·`detached` 가 아닌 세션에 재개는 무동작을 성공으로 보고하지 않고 불일치를 출력하며 0이 아닌 코드로 종료합니다. 재개 대상 0건·없는 식별자·형식 오류도 각각 별도로 안내합니다.
- 두 명령은 **프로젝트 데몬이 상주 중일 때도 실효** 합니다 — 요청이 데몬이 소진하는 control 큐를 경유하므로 상주 프로세스가 변경을 되쓰지 않습니다. 결과를 관측할 수 없으면(데몬이 요청은 가져갔는데 응답이 없는 경우) 명령이 거부하고 `adde restart <proj>` 후 재시도를 안내합니다.

**자동 중지.** 방치한 세션은 알아서 중지됩니다 — 마지막 활동 이후 `stop_after_min`(기본 60)분이 지나면 `idle_stop`(기본 **켬**)이 세션을 `stopped` 으로 옮기고 사유를 "무활동" 으로 기록하며, 그 사유는 중지된 세션의 노트에 표시됩니다. 프로젝트에 `idle_stop false` 를 지정하면 옵트아웃됩니다 — [`project set`](#project-set--설정-편집) 참조. 유휴 내림(`idle_hibernate`/`hibernate_after_min`, 기본 30분)은 종전과 같고 여전히 먼저 일어나며, 상주 엔진 상한을 넘겨 내려가는 세션은 유휴로만 내려가고 중지되지 않습니다.

### `session rm` — 3분기 제거

`session rm` 은 본 릴리스에서 재설계됐습니다. 구 `--force` 플래그는 **제거됐고**(전달하면 미인식 플래그로 거부, exit 2) 그 자리에 대화형 확인이 들어갔습니다.

터미널에서 옵션 없이 실행하면 먼저 지울 대상(경로·턴 수·진행 중 턴 유무)을 보여주고 3분기를 묻습니다:

| 선택          | 삭제 대상                                                                                                                                         | 보존                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **완전 제거** | 그 세션이 소유한 전부: 설정 루트의 레코드·큐·처리중 디렉터리·엔진 로그, **그리고** vault 의 노트·승인 노트·이벤트 기록·본문 저장소·중복 판정 원장 | 그 세션의 것은 아무것도. 다른 세션의 파일은 하나도 건드리지 않습니다 |
| **일반 제거** | 설정 루트 쪽만(레코드·큐·처리중 디렉터리·세션 런타임 디렉터리)                                                                                    | vault 쪽 전부 — 노트·이벤트 기록·blob·중복 판정 원장                 |
| **취소**      | 없음                                                                                                                                              | 전부(0이 아닌 코드로 종료하므로 취소가 완료로 오인되지 않습니다)     |

- **완전 제거는 복구 불가** 이며 확인 문구가 그 사실을 명시합니다. 참조 계산이 필요 없습니다 — 위 경로가 전부 한 세션의 소유이므로 그 세션 디렉터리를 지우는 것으로 완결됩니다.
- **일반 제거** 는 세션을 목록에서만 사라지게 하고 대화는 vault 에서 그대로 읽을 수 있게 남기므로 이후 재생성 명령이 필요하지 않습니다. 남는 입력 노트는 팔레트·전송 체크박스가 없는 짧은 "제거됨" 안내형으로 1회 교체됩니다 — 아무도 폴하지 않는 노트에 체크박스를 남겨 두면 영구히 소비되지 않기 때문입니다.
- **본 릴리스의 저장 배치 변경 이전에 생성된 세션** 은 인벤토리에 그 사실이 표기되고, 완전 제거는 한계를 정직하게 보고합니다: 구 프로젝트 스코프 배치에 승격된 본문은 **그 자리에 그대로 남으므로** 완전 제거가 닿지 못합니다. 그것까지 지우는 유일한 경로는 [`factory-reset`](#factory-reset--전체-초기화) 입니다.
- 대상이 없으면 "대상 없음" 과 0이 아닌 종료 코드를 반환합니다 — 성공한 삭제로 위장하지 않습니다. 일부 경로 삭제가 실패하면 실패분을 모아 출력하고 0이 아닌 코드로 종료합니다.

스크립트·비대화 환경용:

```bash
adde session rm myproj 260828-2 --purge    # 확인 없이 완전 제거
adde session rm myproj 260828-2            # 비대화 셸에서: 거부, 아무것도 지우지 않음
```

`--purge` 는 완전 제거를 의미하며 아무것도 묻지 않으므로 비대화 전용 형태입니다. 터미널 밖에서 옵션 없이 `session rm` 을 실행하면 usage 를 출력하고 아무것도 건드리지 않은 채 exit 2 로 끝납니다(fail-closed) — 파괴적인 선택이 기본값으로 대행되지 않습니다.

### `session attach` / `session detach`

본 릴리스에서 미구현입니다. 구현되면 **TUI 와 교대로 쓰기 위한 소유권 배턴** — 이미 돌고 있는 세션의 터미널을 대화형 클라이언트에 넘기고 다시 가져오는 것 — 이 되며, 세션 중지와는 다른 개념입니다. `stop` 은 감시를 끝내고 재개까지 그 세션이 턴을 받지 않지만, `attach`/`detach` 는 세션이 감시되는지 여부를 바꾸지 않습니다. `detached` **상태** 는 향후의 `detach` 명령과 무관합니다 — 재개가 실패했다는 뜻입니다.

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
adde vault rebuild myproj --sid 260828-2 --json
```

## factory-reset — 전체 초기화

```bash
adde factory-reset
```

**모든 프로젝트와 모든 세션** 을 제거해 ADDE 를 처음 설치 상태로 되돌립니다. 인자도 플래그도 받지 않습니다.

- **삭제**: 인벤토리에 실린 프로젝트마다 설정 루트의 그 프로젝트 디렉터리(`~/.config/adde/projects/<proj>/`) 와 vault ADDE 서브트리(`<vault>/adde/projects/<proj>/` — 노트·이벤트 기록·blob·중복 판정 원장). 삭제 단위는 **프로젝트별**이며 컨테이너를 통째로 지우지 않습니다 — 컨테이너 자체는 비게 된 경우에만 정리합니다.
- **보존**: vault 루트 자체와 그 안의 ADDE 네임스페이스 밖 파일 전부. `~/.config/adde/<proj>/` 의 v0.2.x 데이터는 건드리지 않으며, 결과 출력에 보존한 항목을 명시합니다.
- **읽을 수 없는 것은 보존**: 이름이 허용 문자셋 밖이거나 설정 파일을 파싱할 수 없는 디렉터리는 **일부러 그대로 남기고** 인벤토리에 "삭제 대상에서 제외" 로 열거합니다 — 보여 준 범위와 실제 삭제 범위를 일치시키기 위해서입니다.
- **명령 전용**: 노트·팔레트 진입점을 의도적으로 만들지 않습니다. 동기화 충돌 사본이나 오체크 하나로 설치 전체가 파괴될 수 있기 때문입니다.
- **대화형 전용**: 비대화 환경에서는 아무것도 지우지 않고 거부하며 0이 아닌 코드로 종료합니다.
- **확인 절차**: 먼저 인벤토리(프로젝트 수·프로젝트별 세션 수·vault 경로·보존 대상)를 출력하고, 그 다음 **고정 문구를 정확히 타이핑** 하도록 요구합니다. 예/아니오 단축은 없고, 문구가 어긋나면 아무것도 지우지 않습니다.
- **데몬은 먼저 내려야 합니다**: 각 프로젝트의 데몬을 정지한 뒤 잔존 여부를 확인합니다. 살아남은 데몬이 있으면 **삭제를 하나도 하지 않습니다** — 상주 데몬이 지운 레코드를 되만들어 반쯤 초기화된 상태가 되기 때문입니다.
- **정직한 실패**: 부분 실패를 성공으로 보고하지 않습니다 — 남은 경로를 열거하고 0이 아닌 코드로 종료합니다.
- **잔존 디렉터리**: 알려진 vault 안에 있으나 어떤 프로젝트 설정도 가리키지 않는 ADDE 프로젝트 디렉터리는 **별도로** 열거·확인합니다(기본은 보존). 어떤 설정에도 언급되지 않은 vault 의 디렉터리는 애초에 발견할 수 없습니다 — 그래서 삭제 전에 인벤토리를 먼저 만들고, 결과에도 이 한계를 밝힙니다.
- **vault 를 찾을 수 없는 프로젝트**(경로 없음·권한 거부·링크 루프 등)는 인벤토리에 경로와 사유가 함께 표시되고, 고정 문구 확인 뒤 **별도 질문**으로 "설정만 지울지" 를 따로 묻습니다(기본은 아니오). vault 쪽은 어느 경우에도 손대지 않습니다 — 삭제 범위를 확정할 수 없기 때문입니다. 동의하지 않으면 설정을 남겨 그 vault 에 남은 데이터의 위치 단서를 보존하며, 그 사실을 결과에 밝힙니다.
- **삭제 직전 실경로 재확인**: 대상의 실제 위치가 그 vault 의 ADDE 폴더 안이 아니면 — 경로 구성요소가 심볼릭 링크여서 vault 밖을, 또는 vault 안의 다른 폴더를 가리키는 경우 포함 — vault 삭제와 그 프로젝트의 설정 삭제를 **모두 보류**하고 사유와 함께 "링크를 정리한 뒤 다시 실행" 을 안내하며 0이 아닌 코드로 종료합니다. 설정이 vault 위치를 알려주는 유일한 기록이라, 설정만 지우면 남은 데이터를 다시 찾을 수 없기 때문입니다. 잔존 디렉터리 삭제에도 같은 확인이 적용됩니다.
- **알려진 한계**: 확인과 삭제 사이에 경로가 링크로 교체되는 경합은 막지 못합니다(Node 파일 API 에 "검사한 그 대상" 만 지우는 수단이 없습니다). 동기화 클라이언트가 심볼릭 링크를 어떻게 재현하는지는 확인되지 않았으므로, 동기화되는 vault 안에 ADDE 폴더 밖을 가리키는 링크는 두지 않는 편이 안전합니다. 확인 화면에 표시되는 외부 유래 문자열(설정의 vault 값·디렉터리 이름)은 제어문자를 접어 표시하며 서식·양방향 문자는 대상이 아닙니다. 살균은 표시에만 적용되고 삭제 범위는 영향받지 않습니다.
- 릴리스 이전 저장 배치로 승격된 본문 중 세션 단위 완전 제거가 닿지 못하는 부분을 지우는 유일한 경로입니다 — [`session rm`](#session-rm--3분기-제거) 참조.

## 세션 제어(마크다운 팔레트)

세션 초기화·압축·중지·재개는 CLI 가 아니라 **채널에서** 지시합니다 — 각 세션 입력 노트 상단에 상주하는 체크박스 팔레트(`markdown.palette`, 기본 켬). 팔레트는 기능별 그룹으로 묶이고 그룹마다 체크박스가 아닌 머리글 줄이 붙습니다:

| 그룹      | 마커               | 결과                                                                                            |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `records` | `- [ ] 🗄️ archive` | 기록 존의 완료된 전송 마커를 요약 한 줄로 접음                                                  |
| `session` | `- [ ] 🗜️ compact` | 엔진 자체 압축 명령 실행(엔진이 압축 지원을 선언한 경우에만 렌더) — 성공하면 안내로 알려 줍니다 |
| `session` | `- [ ] 🧹 clear`   | 이 세션을 중지하고 새 세션 시작(승계 — [`session clear`](#session--세션-관리) 참조)             |
| `session` | `- [ ] ⏹️ stop`    | **이 세션만** 중지 — 새 세션을 만들지 않습니다                                                  |
| `session` | `- [ ] ♻️ resume`  | 이미 중지된 **다른** 세션을 재개 — 아래 참조                                                    |

그룹 머리글은 체크박스가 아닌 굵은 글씨 줄이라 액션으로 파싱되지 않고 초안 텍스트로도 오인되지 않습니다.

**`resume` 의 의미가 본 릴리스에서 바뀌었습니다.** 이전에는 "이 세션의 엔진 재개 재시도" 였고, **그 항목은 이제 없습니다.** 유휴 세션은 다음 지시에서 투명하게 재개되고 떨어진 세션은 다른 세션의 재개 목록에서 다루므로 손이 닿지 않는 세션은 생기지 않습니다 — 다만 자기 세션을 되살리려고 `resume` 을 체크하던 습관이 있다면 그 항목이 이렇게 바뀌었다는 사실을 알아 두세요. `resume` 은 이제 **활성** 세션 노트에서 두 형태로 동작합니다:

- `- [x] ♻️ resume` — 다음 주기에 안내 존이 중지·떨어진 세션들을 체크박스 목록으로 렌더합니다(식별자·제목·마지막 활동·상태, 떨어진 세션은 사유까지). 하나를 체크하면 그 세션이 재개되고 목록은 사라집니다. 목록은 **최근 10건** 까지 표시하며, 절단되면 그 사실과 함께 전체는 `adde session ls <proj>` 로 보라고 안내합니다. 대상이 0건이면 빈 목록 대신 짧은 안내만 남습니다.
- `- [x] ♻️ resume 260828-2` — 목록 단계를 건너뛰고 그 식별자를 바로 재개합니다(정확 일치). 없는 식별자·형식 오류는 각각 별도 안내가 남습니다.

마커를 체크하면 1회 실행되고 제자리에서 미체크로 복원됩니다 — 상주 컨트롤이지 1회성 메시지가 아닙니다.

**중지된 세션의 노트에는 팔레트가 아예 없습니다.** 세션이 중지되면 입력 노트가 1회 교체되어 (a) 이 노트가 더 이상 감시되지 않는다는 사실 (b) 중지 사유 (c) 되살리는 두 경로(활성 세션 노트의 `♻️ resume`, 터미널의 `adde session resume <proj> <sid>`)를 담은 안내형이 됩니다 — 체크할 활성 세션이 하나도 없을 수 있으므로 CLI 경로를 반드시 함께 적습니다. 체크박스는 `records` 그룹까지 포함해 **하나도 남지 않습니다**: 그 노트를 아무도 폴하지 않으므로 남은 체크박스는 영구히 소비되지 않기 때문입니다. 초안 텍스트와 기록 존은 보존되며, 재개하면 정상 레이아웃이 초안과 함께 복구됩니다. 떨어진 세션의 노트도 같은 방식으로 교체되고 배너에 떨어진 사유가 실립니다.

안내 존을 포함한 노트 레이아웃 전체는 [마크다운 가이드](markdown.ko.md#2-지시-보내기입력-노트) 참조. 본 릴리스에서 Telegram/Discord 는 미구현(stub) 이라 채팅 명령 대응물이 아직 없습니다.

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
- **1**: 성공이 아닌 나머지 — 운영 실패, 지원하지 않는 명령/하위명령, `doctor` 의 `FAIL` 항목, 또는 `status` 의 실패 조건(`detached` 세션 · 크래시루프 자가 정지 기록 · 데몬이 `응답 없음`/`비정상 종료` · 라이브니스·자가 정지 기록 판독 불가(상태 판정 불가) — 표시 필터와 무관하게 등록된 전체 프로젝트 기준. 데몬이 단순히 `미기동`인 것만으로는 실패가 아닙니다).

## 언어(로케일)

- **결정 순서**: `ADDE_LANG`(명시) > `LC_ALL` > `LC_MESSAGES` > `LANG`(`ko*` → 한국어) > 기본 영어.
- **프로젝트별 채널 언어**: `adde project set <proj> lang <en|ko>` 로 해당 프로젝트 채널 메시지(권한 프롬프트·통지)의 언어를 고정합니다. 미지정 시 데몬의 전역 로케일을 따릅니다.

## 경로

- 설정 루트: `~/.config/adde`(`ADDE_HOME` 로 재정의).
- 프로젝트 설정: `<설정루트>/projects/<proj>/{project.conf, sessions.d/<sid>.json, .env, runtime/{runtime.json, engines.json, retention-last-run, control/, sessions/<sid>/{queue, processing, engine.log}}}`.
- vault(`project add --vault` 지정): `<vault>/adde/projects/<proj>/{project.md, sessions/<sid>/{session.md, inbox.md, approvals/<permId>.md, turns/<NNNN ts>.md}, .adde/sessions/<sid>/{events-NNNN.jsonl, gen-NNNN.summary.json, blobs/<aa>/<sha256>, dedup.jsonl}}`.
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist`(macOS 전용).

설정·시크릿·런타임 상태는 설정 루트에, 대화 데이터(이벤트·노트·첨부·중복 판정)는 지정한 vault 에만 있습니다.

**본문 저장소·중복 판정 원장의 세션별 분리(BREAKING).** 첨부와 임계 초과 도구 출력의 내용 주소 저장소, 그리고 완전 일치 중복을 기록하는 원장이 이제 프로젝트 공유가 아니라 **세션 소유** 입니다(`.adde/sessions/<sid>/blobs/`·`.adde/sessions/<sid>/dedup.jsonl`). 두 가지 결과가 따라옵니다:

- **중복 판정이 세션 안으로 좁혀집니다.** 같은 내용을 서로 다른 두 세션에 보내면 두 번째가 첫 번째로 링크되지 않고 각 세션이 본문을 온전히 보유합니다. 한 세션 안에서의 반복은 종전처럼 최초 턴으로 링크됩니다. 이는 의도한 축소입니다 — 파괴적 경로에서 참조 계산이 사라져 다른 세션이 아직 가리키는 본문을 완전 제거가 지우는 일이 구조적으로 불가능해집니다.
- **"내용이 같으면 실제 저장은 한 번만" 이라는 기존 보장이 프로젝트 전체가 아니라 세션 단위로 축소됩니다.** 같은 첨부를 두 세션이 보유하면 디스크에도 두 개가 존재하고, 동기화 도구의 업로드도 두 번 일어납니다.

이 변경 이전에 기록된 데이터는 **있던 자리에 그대로 남습니다**(`<vault>/adde/projects/<proj>/.adde/blobs/`·`.adde/ledger/dedup.jsonl`) — 이동도 재작성도 하지 않으며 실행할 마이그레이션이 없습니다. 그 대가는 [`session rm`](#session-rm--3분기-제거) 에 적힌 대로입니다: 변경 이전에 생성된 세션은 완전 제거가 구 위치의 본문에 닿지 못하고, 완전한 보장은 [`factory-reset`](#factory-reset--전체-초기화) 으로만 가능합니다.

## macOS 전용 기능

`adde up`/`down`/`restart` 는 macOS launchd 에 의존합니다. 다른 OS 에서는 이 명령들이 오류를 반환합니다(현재 범위 밖).

**재부팅 자동복구**: `adde up` 으로 등록된 데몬은 macOS 재부팅·로그아웃 후 항상 재기동되며(`RunAtLoad`), `active` 였던 모든 세션이 자동 재개됩니다. 크래시 자동 재기동(`KeepAlive`)은 별개이며 제한이 걸려 있습니다 — [`project.conf` auto_restart](#project--프로젝트-관리)·[크래시 안전성](troubleshooting.ko.md#크래시-안전성로그-회전) 참조.

## v0.2.x 에서 이전

- `lane add/set/ls/show/rm` → `project add/set/show/ls/rm`(프로젝트 수준 설정) + `session new/ls/show/clear/stop/resume/rm`(대화별) + `bind add/rm/ls`(채널↔세션 연결).
- `sessions <proj> <lane>` → `session ls <proj>`.
- `proj ls/rm` → `project ls/rm`.
- `~/.config/adde/<proj>/` 의 v0.2.x 설정·데이터는 v2 가 **읽지도 변경하지도 않습니다** — `adde doctor` 가 안내 목적으로만 존재를 보고합니다. v2 는 물리적으로 분리된 설정 루트(`~/.config/adde/projects/<proj>/`)를 씁니다.
