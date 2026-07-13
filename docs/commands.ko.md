_[English](commands.md) | 한국어_

# 명령 레퍼런스

ADDE CLI 의 전체 명령·옵션입니다. 주 진입점은 `adde` 하나입니다. 짧은 별칭(`ad`·`add`)은 기본 설치되지 않으며, `adde init`(온보딩 마법사) 또는 `adde alias` 로 옵트인 설치할 수 있습니다.

## 목차

- [전역 옵션](#전역-옵션)
- [init — 온보딩 마법사](#init--온보딩-마법사)
- [alias — 단축 별칭 설치](#alias--단축-별칭-설치)
- [up — 레인 기동 (데몬)](#up--레인-기동-데몬)
- [down — 레인 종료](#down--레인-종료)
- [restart — 레인 재기동](#restart--레인-재기동)
- [proj.conf — 데몬 크래시 자동 재기동](#projconf--데몬-크래시-자동-재기동)
- [status — 레인 상태](#status--레인-상태)
- [doctor — 환경 점검](#doctor--환경-점검)
- [logs — 최근 활동](#logs--최근-활동)
- [sessions — 세션 목록](#sessions--세션-목록)
- [세션 제어 (채널 명령)](#세션-제어-채널-명령)
- [lane — 레인 설정](#lane--레인-설정)
- [proj — 프로젝트 목록·삭제](#proj--프로젝트-목록삭제)
- [completion — 셸 자동완성](#completion--셸-자동완성)
- [도움말·오타 힌트](#도움말오타-힌트)
- [종료 코드](#종료-코드)
- [언어(로케일)](#언어로케일)
- [경로](#경로)
- [macOS 전용 기능](#macos-전용-기능)

## 전역 옵션

| 옵션              | 설명        |
| ----------------- | ----------- |
| `-v`, `--version` | 버전 출력   |
| `-h`, `--help`    | 도움말 출력 |

`-v`/`--version`·`-h`/`--help` 는 인자 목록 어느 위치에 있어도 인식됩니다 — 예: `adde up --version` 은 `--version` 을 프로젝트명으로 오인하는 대신 버전을 출력합니다(`[behavior-change]`).

인자 없이 `adde` 를 실행하거나 `-h`/`--help`/`help` 는 전체 사용법을 출력합니다. 특정 명령의 도움말은 `adde <command> --help` (예: `adde status --help`, `adde lane add --help`) — `--help` 앞에 알려진 명령이 있으면 그 명령의 사용법을, 없으면 전체 사용법을 출력합니다.

## init — 온보딩 마법사

```bash
adde init [<proj>]
```

첫 레인을 대화형으로 만드는 온보딩 마법사입니다(**TTY 전용** — 비대화형에서는 오류를 출력하고 종료 코드 1). 다음 순서로 진행합니다:

1. 전역 `doctor` 를 실행해 결과를 출력합니다(`FAIL` 이 있어도 경고와 함께 계속 진행).
2. 짧은 별칭 설치를 제안합니다(기본 예 — 아래 `alias` 참조).
3. 프로젝트·레인 이름을 묻습니다(검증: 영문·숫자·`_`·`-` 만 허용).
4. 레인 필드를 대화형으로 입력받습니다(대화형 `lane add` 와 동일한 필드). telegram 레인은 봇 토큰을 **마지막에 가려진 입력**(키 입력이 화면에 에코되지 않음)으로 받아 `.env`(0600)에 기록합니다. 비워 두면 나중으로 미루며(`--token-stdin` 또는 `.env` 직접 편집으로 설정), 그 경우 완료 출력이 토큰 저장 대신 안내가 됩니다.
5. 레인을 생성합니다.
6. 토큰 기록(또는 토큰 저장 안내) 힌트와 `adde up` 기동 힌트를 출력합니다.

**예시 세션** (telegram 레인, 토큰은 가려진 입력 — 화면에 표시되지 않음):

```text
$ adde init
adde 설정 — 환경 점검, 짧은 별칭, 첫 레인을 만듭니다.

  ✔ Node 버전: v22.14.0
  ✔ ACP 어댑터 바이너리: @agentclientprotocol/claude-agent-acp 해석됨
  ✔ 설정 base 디렉터리: ~/.config/adde
  ✔ 데몬 진입 파일: /opt/homebrew/lib/node_modules/adde/dist/cli/adde.js

짧은 별칭(ad, add)을 adde 명령 옆에 설치할까요? (Y/n) [y]: y
  ✔ 별칭 생성: ad → /usr/local/bin
  ✔ 별칭 생성: add → /usr/local/bin

프로젝트 이름 [default]: myproj
레인 이름 [main]: tg-claude
source (번호 또는 값 입력)
  1) markdown
  2) telegram [markdown]: 2
perm_tier (acp = 도구마다 채널 승인 / autopass = denylist 외 자동 허용)
  1) acp
  2) autopass [acp]:
allowlist (콤마 구분, 없으면 비움): Read,Grep
방어심화 하드-거부 기본값을 켤까요? sudo / rm -rf / git 강제 / 자격증명 읽기를 즉시 차단 (y/N) [y]: y
lang (채널 메시지 로케일, 전역은 비움)
  1) en
  2) ko:
cwd (레인 작업 폴더 절대경로, 없으면 비움): /Users/me/work/my-project
engine_args (엔진 프로세스에 전달할 추가 CLI 인자, 공백 분리, 없으면 비움 — 시크릿은 넣지 마세요: OS 프로세스 목록에 노출됩니다):
file_mode (private=소유자 전용 0700 / shared=umask 기본 유지, 통상 타 사용자 열람)
  1) private
  2) shared [private]:
chat_id (회신 대상 + 해당 chat 인바운드 허용, 없으면 비움): 12345678
allow_from (추가 허용 발신자 id, 콤마 구분, 없으면 비움):
telegram 봇 토큰 (가려진 입력, 나중에 설정하려면 비움): ⟨입력 숨김⟩

레인 "tg-claude" 생성: ~/.config/adde/myproj/lanes.d/tg-claude.conf
토큰 기록: ~/.config/adde/myproj/state/tg-claude/.env (0600)

프로젝트 'myproj' 설정 완료.
기동: adde up myproj
```

빈 응답은 표시된 기본값(`[…]`)을 채택합니다. 토큰을 비워 두면 마지막 두 줄이 `토큰 기록` 대신 `다음: 봇 토큰을 …/.env 에 TELEGRAM_BOT_TOKEN=... 으로 두세요` 안내가 됩니다. `markdown` 소스에서는 `chat_id`/`allow_from`/토큰 프롬프트가 `root`/`inbox`/`approvals`/`outbox` 로 바뀝니다.

## alias — 단축 별칭 설치

```bash
adde alias [names...]
```

PATH 에서 찾은 `adde` 실행 파일 옆에 짧은 별칭 심링크를 설치합니다(기본 `ad`·`add`). 이름을 인자로 주면 그 이름들로 설치합니다.

- `[names...]`: 설치할 별칭 이름 하나 이상(기본 `ad add`). 예: `adde alias co assistant` 는 `co`·`assistant` 를 설치.
- **이미 존재하는 명령은 건너뜀**: PATH 에 그 이름의 명령이 이미 있고 우리 심링크가 아니면 **덮어쓰지 않고 실패로 보고**합니다.
- **멱등**: 이미 adde 를 가리키는 심링크는 "이미 설정됨" 으로 보고합니다.
- **`adde` 미발견**: PATH 에서 `adde` 를 찾지 못하면(예: 전역 설치가 아님) 안내를 출력하고 종료 코드 1.

## up — 레인 기동 (데몬)

```bash
adde up <proj>
```

`~/.config/adde/<proj>/lanes.d/` 의 모든 `*.conf` 레인을 **macOS launchd LaunchAgent 데몬**으로 기동합니다. `adde up` 자체는 plist 등록 후 즉시 종료되고, 실제 레인은 백그라운드 데몬(`launchd` 관리)으로 상주합니다.

- **터미널 독립**: 터미널을 닫아도 데몬이 계속 동작합니다.
- **크래시 전용 자동 재기동**: launchd 는 크래시(비정상 종료 코드 또는 치명적 시그널) 시에만 데몬을 재기동하며, 최소 60초 간격으로 제한됩니다. macOS 재부팅·로그아웃 후에는 (`proj.conf` 의 `auto_restart` 값과 무관하게) 항상 재기동됩니다(`RunAtLoad`). 의도적 정지(`adde down`, 또는 graceful shutdown 을 완주한 `SIGTERM`)는 정상 종료로 귀결되어 **재기동되지 않으며**, 상주할 이유가 없는 결정적 부팅 실패(예: 기동된 레인 0개)도 무한 재시도 없이 정상 종료합니다 — 실패는 그대로 표면화되며(아래 참조) 자동 재시도만 하지 않습니다. 끄는 방법은 [`proj.conf`](#projconf--데몬-크래시-자동-재기동) 참조, 자가 정지 안전망은 [크래시 안전·로그 회전](troubleshooting.ko.md#크래시-안전--로그-회전) 참조.
- **기동 결과 표기**: 등록 후 `adde up` 은 데몬이 기록하는 **부팅 리포트**(`<base>/<proj>/daemon-boot-report.json` — `supervisorUp` 완료 시 1회 기록, 레인별 최종 상태/사유 + boot id 포함)를 대기하고, 이번에 개시한 부팅에 대응하는 리포트만 소비합니다(이전 부팅의 잔존 리포트를 이번 결과로 오인하지 않음). 이후 요약을 출력합니다(`실행 중 N · 실패 M`). **기동 실패한 레인**은 사유와 함께 나열하고 `adde up` 이 비정상 종료코드로 끝나, `adde status` 를 따로 확인하지 않아도 실패를 바로 알 수 있습니다(리포트가 전 레인 실패를 명시하면 대기 상한을 소진하지 않고 즉시 표면화 / 실패는 `error` 상태로도 기록 — 데몬 레벨 원인은 `adde logs <proj> --daemon`). 대기 상한 내에 **대응 리포트가 기록되지 않으면**(데몬이 리포트 기록 전 부팅에 실패했을 가능성) 이를 알리고 `adde logs <proj> --daemon` 포인터와 함께 비정상 종료합니다. 느린 머신에서는 `ADDE_UP_WAIT_MS`(ms) 환경변수로 대기 상한을 늘릴 수 있습니다 — 기본값은 `8000`이며 **양수** 정수만 유효합니다(숫자가 아니거나 0·음수면 조용히 기본값으로 대체됩니다). 구 `ADDE_UP_POLL_MS` 는 **더 이상 해석되지 않습니다**(폴백 없음) — 구 변수만 설정돼 있으면 `ADDE_UP_WAIT_MS` 로 이관하라는 안내가 stderr 에 1회 출력됩니다. `adde restart` 도 재적재 후 자신의 부팅 리포트를 동일한 방식으로 대기하며 같은 환경변수를 따릅니다.
- **이미 기동 중 안내**: 데몬이 이미 등록돼 있고 **실행 중인 레인이 하나 이상**이면 `adde up` 은 재등록(=already loaded 실패)하지 않고, 실행 중/전체 레인 수와 함께 "이미 기동 중" 을 안내합니다(확인 `adde status`, 설정 반영 `adde restart`, 종료 `adde down`). 현재 비정상 레인(`error`/`dead`/`stale`)이 있으면 여기서도 나열하고 비정상 종료합니다. 등록은 남아 있는데 **실행 중인 레인이 하나도 없으면**(예: 결정적 부팅 실패 후 정상 종료된 경우) `adde up` 은 단순히 "이미 기동 중"으로 보고하지 않고, 데몬을 재적재(unload+load)해 복구한 뒤 신규 기동처럼 폴링합니다.
- **중복 기동 가드**: 데몬 내부에서 이미 실행 중인 레인은 경고와 함께 스킵합니다(데몬 로그에 기록). 이중 기동은 발생하지 않습니다.
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
- **[behavior-change] 기동 결과 표기**: 재등록 후 `up` 과 동일하게 자신의 부팅 리포트를 대기해 요약(`실행 중 N · 실패 M`)을 출력합니다. **기동 실패한 레인**은 사유와 함께 나열하고, 실패 레인이 하나 이상이면 `restart` 가 이제 **종료 코드 1** 을 반환합니다(기존: launchctl 재등록 자체가 예외를 던지지 않는 한 항상 0 이라 레인 기동 실패가 성공처럼 보였습니다). 전 레인 기동 성공 시에는 여전히 exit 0. `restart` 는 대기 대상 부팅에 앞서 크래시루프 자가정지 마커도 해제하므로, 명시적 재시도가 잔존 halt 로 막히지 않습니다. 대기 상한은 `up` 과 동일한 `ADDE_UP_WAIT_MS` 환경변수를 따릅니다([`up`](#up--레인-기동-데몬) 참조).
- plist 는 매 `restart`(및 매 `up`)마다 처음부터 다시 렌더링되므로 [`proj.conf`](#projconf--데몬-크래시-자동-재기동) 의 `auto_restart` 값을 항상 즉시 반영합니다 — 별도 마이그레이션 절차가 없습니다.
- `restart` 는 크래시 루프 자가 정지 마커도 초기화합니다(명시적 재시도이므로 — [크래시 안전·로그 회전](troubleshooting.ko.md#크래시-안전--로그-회전) 참조).

## proj.conf — 데몬 크래시 자동 재기동

`<base>/<proj>/proj.conf` 는 (레인별이 아닌) 프로젝트 수준 평면 `key=value` 설정 파일이며 직접 편집합니다 — 이를 위한 `adde` 서브커맨드·플래그는 없습니다.

```
# ~/.config/adde/<proj>/proj.conf
auto_restart=false
```

- **키**: `auto_restart`(boolean). 기본값은 **on** — 파일 부재·키 부재·무효값은 모두 on 으로 처리되며, 오직 명시적 `false` 만 off 입니다.
- **효과**: launchd 가 크래시 후 데몬을 자동 재기동할지를 결정합니다([`up`](#up--레인-기동-데몬) 의 크래시 전용 자동 재기동 노트 참조). `RunAtLoad`(재부팅·로그아웃 자동 복구)에는 영향을 주지 않으며(설정과 무관하게 계속 동작), 의도적 정지(`adde down` 은 이 설정과 무관하게 항상 데몬을 정지)에도 영향이 없습니다.
- **`auto_restart=false` 사용 시점**: 데몬이 계속 크래시해서 원인을 조사하는 동안 launchd 가 백그라운드에서 계속 재시도하는 것을 원치 않는 경우(예: 실패한 1회 실행을 그대로 관찰하고 싶을 때), 또는 중간 재기동 없이 크래시 루프 자가 정지로만 관찰하고 싶은 경우입니다. 꺼두면 크래시 후 `adde up`/`adde restart` 를 실행하기 전까지 데몬이 죽은 채 남으며, `adde status`/`adde doctor` 가 이를 "등록됨-미실행" 상태로 표면화해 `running` 으로 오인되지 않게 합니다.
- 변경 반영에는 `adde restart <proj>` 가 필요합니다(plist 는 매 `up`/`restart` 시 `proj.conf` 로부터 재렌더링됩니다).

## status — 레인 상태

```bash
adde status [<proj>] [--all] [--json]
```

`lanes.d` 의 각 레인을 스캔해 상태를 판정합니다.

| 상태      | 의미                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running` | 상태 파일이 있고 기동 프로세스(pid)가 살아있으며 하트비트가 신선함                                                                                                        |
| `stale`   | pid 는 살아있으나 하트비트(상태 파일 mtime)가 끊김 — **행(hung) 의심, 또는 엔진 크래시 자가 회복 진행 중**([문제해결](troubleshooting.ko.md#엔진-크래시--자가-회복) 참조) |
| `dead`    | 상태 파일이 있으나 프로세스가 없음 — **비정상 종료(크래시) 잔존**                                                                                                         |
| `error`   | 레인 **기동 실패**(엔진 spawn/handshake·설정 누락 등), 또는 기동 후 크래시된 엔진이 **자가 회복을 포기**(또는 `auto_relaunch=false` 로 비활성) — 사유가 기록·표시됨       |
| `stopped` | 상태 파일 없음 — 정상 종료 또는 미기동                                                                                                                                    |

- **`<proj>` 지정**: 해당 프로젝트의 모든 레인(정지 포함)을 `LANE · STATUS · PID · UPTIME · SEEN · SOURCE` 표로 출력.
- **`<proj>` 생략**: 전 프로젝트(`~/.config/adde/*/`)를 집계해 **실행 중(정지 제외) 레인**을 `PROJECT · LANE · …` 표로 출력. 실행 중 레인이 없으면 안내 메시지.
- **`--all`**(`<proj>` 생략 시): 정지(`stopped`) 포함 전 레인을 표시.
- `dead`·`stale`·`error` 레인이 있으면 조치 안내를 덧붙입니다(`SEEN` = 마지막 하트비트 경과; `error` 는 기동 실패 사유와 `adde logs <proj> --daemon`/`--engine` 포인터).
- 하트비트: `adde up` 이 주기적으로 상태 파일 mtime 을 갱신합니다. pid 가 살아있어도 갱신이 임계 시간 멈추면 `stale`(행) 로 판정합니다.
- **크래시루프 자가 정지(`halt`)**: 데몬이 짧은-수명 크래시 반복으로 자가 정지했으면([크래시 안전·로그 회전](troubleshooting.ko.md#크래시-안전--로그-회전) 참조) `status` 가 해당 프로젝트에 경고를 출력하고 **이제 종료 코드도 1** 을 반환합니다(기존: `halt` 는 경고 텍스트만 출력하고 종료 코드엔 반영되지 않았습니다 — 기존 `dead`/`stale`/`error` → exit 1 규칙은 그대로 유지됩니다). 인자 없는 집계 뷰는 화면에 표시되는 레인 목록이 아니라 대상 프로젝트 전체를 기준으로 halt 를 판정합니다 — 어떤 프로젝트의 모든 레인이 `stopped` 라 기본 집계 표에서 제외되더라도, 그 프로젝트의 halt 경고와 exit 1 은 그대로 반영됩니다.
- **[BREAKING] `--json`**: 최상위 JSON 출력이 배열이 아니라 **`{ "lanes": [...], "halt": ... }` 객체**입니다(기존에는 `adde status --json` 이 레인 객체 배열을 최상위로 출력했습니다). `lanes` 는 기존과 동일한 레인별 객체를 담습니다(`lastSeenAt` 포함, 집계 시 `proj` 부기). `halt` 는 크래시루프 자가정지 상태를 담습니다 — 단일 `<proj>` 뷰는 `HaltRecord | null`, 인자 없는 집계 뷰는 `{ "<proj>": HaltRecord | null, ... }`. **마이그레이션**: 기존 최상위 배열 참조를 `.lanes` 로 바꾸세요 — 예: `adde status --json | jq '.[]'` → `jq '.lanes[]'`. 텍스트(비-JSON) 출력은 변경 없습니다.
- **업데이트 안내**: npm 에 새 버전이 있으면 안내 한 줄(`npm i -g adde-acp@latest` … 후 `adde restart`)을 덧붙입니다. 24시간 캐시(설정 base 하위)를 쓰며, 대화형 터미널(TTY)에서만 네트워크를 조회하고, `ADDE_NO_UPDATE_CHECK` 환경변수로 끌 수 있습니다.
- 읽기 전용(부수효과 없음).

```bash
adde status myproj          # 한 프로젝트의 레인별 표(정지 포함)
adde status --all           # 전 프로젝트, 정지 레인 포함
adde status myproj --json   # 기계 판독 {lanes, halt} 객체(모니터링/스크립트)
```

## doctor — 환경 점검

```bash
adde doctor [<proj>] [--json]
```

상태와 무관한 정적 점검을 수행하고 각 항목을 `PASS` / `WARN` / `FAIL` 로 보고합니다. 실패·경고에는 조치 힌트(`↳ 조치:`)가 붙습니다.

- 전역: Node 버전(≥22) · ACP 어댑터 바이너리 해석 · 설정 base 디렉터리 · (macOS) 데몬 진입 파일 해석.
- `<proj>` 지정 시 레인별: source 유효성 · `cwd` 존재 · (telegram) `.env` 토큰 존재.
- **파일 권한 점검**(`<proj>` 지정 시 레인별): `state/<lane>/.env` 가 그룹/기타 사용자에게 열려 있으면(기대 0600 — 봇 토큰 노출 위험) `WARN`, `file_mode=private` 인데 `state/<lane>` 디렉터리가 그룹/기타 사용자에게 열려 있으면(기대 0700) `WARN` 하고 `chmod`/`adde restart` 힌트를 붙입니다. `file_mode=shared` 는 의도된 선택으로 보고 경고하지 않습니다.
- `<proj>` 지정 시 macOS에서는 launchd 데몬 등록 상태도 점검합니다 — plist 존재 여부와 launchctl 등록 여부를 교차 확인하고, 불일치(plist는 있으나 launchd 미등록, 또는 그 역)를 `WARN`으로 표면화합니다.
- **`--json`**: 점검 목록을 사람용 심볼 목록 대신 JSON 배열로 출력합니다(각 항목의 `name`/`level`/`detail`, `WARN`/`FAIL` 시 `hint` 포함)하고, 요약 줄·업데이트 안내는 억제합니다(기계가독 출력만). 종료 코드 의미는 불변(`FAIL` 존재 → 1, 아니면 0 — 텍스트 모드와 동일). `--json` 없이 호출하면 기존과 완전히 동일합니다(additive).
- **업데이트 안내**: `status` 와 동일하게, npm 에 새 버전이 있으면 안내 한 줄을 표시합니다(24시간 캐시·TTY 에서만 조회·`ADDE_NO_UPDATE_CHECK` 로 비활성) — `--json` 모드에서는 억제됩니다(위 참조).
- 읽기 전용. 기동 전 "왜 안 뜨나"를 자가 진단하는 용도입니다.

```bash
adde doctor myproj --json   # 기계 판독 점검 목록(CI/모니터링)
```

## logs — 최근 활동

```bash
adde logs <proj> <lane> [N] [--engine] [--follow|-f]
adde logs <proj> --daemon [N]
```

해당 레인의 `transcript.log`(ACP 세션 이벤트 기록) 최근 `N` 줄을 출력합니다(기본 50). 파일이 없으면 안내를 출력합니다.

- `N`: 출력할 마지막 줄 수(기본 50). 지정했으나 양의 정수가 아니면(비숫자·`0`·음수) stderr 에 경고를 출력하고 기본값 50 으로 폴백합니다(기존: 무경고 폴백) — 이 검증은 `--daemon` 경로에서도 동일하게 적용됩니다.
- `--engine`: transcript 대신 `engine.log`(엔진 서브프로세스 stderr 캡처)를 출력합니다. 엔진 자체의 진단 출력을 볼 때 사용합니다(`stale`/기동 실패 원인 추적 등).
- `--daemon`: 프로젝트의 **launchd 데몬 로그**(`~/Library/Logs/adde/<proj>.err.log`)를 출력합니다(`<lane>` 불필요). 데몬(분리 프로세스)의 출력, 특히 **기동 실패 원인**이 여기 쌓이며, 레인 transcript/engine 로그로는 볼 수 없습니다.
- **`--follow`/`-f`**: 초기 스냅샷 출력 후 종료하지 않고 상주하며 신규 추가 라인을 실시간 출력합니다(`tail -f` 와 유사) — 기본 transcript, `--engine` 지정 시 engine 로그, 스냅샷이 읽은 지점에서 정확히 이어받아 추적합니다(공백·중복 없음). OS 변경 알림(상위 디렉터리 `fs.watch`)을 1차 트리거로 삼고, 알림이 미지원이거나 이벤트를 놓치는 상황에 대비해 저빈도(1초) stat 폴링을 안전망으로 상시 병행해 추적이 조용히 멈추지 않게 합니다. 로그 회전(5MB 크기 기반 세대 회전)은 물론, 동일 inode 로 truncate 된 직후 재성장하는 경우(`copytruncate` 류 회전)에도 유실·중복·어긋남 없이 투명하게 추적하며, 한글 등 멀티바이트 문자가 읽기 경계에서 분할돼도 깨지지 않고 온전하게 출력됩니다. `Ctrl-C`(`SIGINT`) 로 즉시 정지합니다(hang·busy-poll 없음). 시작 시 대상 로그가 아직 없으면 기존과 동일한 "부재" 안내를 출력하고 종료합니다(생성 대기 상주하지 않음). `--daemon` 로그는 follow 대상이 아닙니다 — `--daemon` 에서는 `-f` 가 무시되고 스냅샷만 출력됩니다.

```bash
adde logs myproj tg-claude 100 --engine   # 엔진 stderr 로그 마지막 100줄
adde logs myproj --daemon                 # 데몬 로그(레인 기동 실패 원인)
adde logs myproj tg-claude -f             # transcript 라이브 tail
adde logs myproj tg-claude --engine -f    # engine 로그 라이브 tail
```

## sessions — 세션 목록

```bash
adde sessions <proj> <lane> [--json]
```

레인의 엔진 세션 장부를 출력합니다 — 번호·첫 프롬프트 발췌·**마지막 대화 시각**·세션 id(현재 세션은 `◀` 표시). 세션 재개·초기화는 채널에서 수행합니다(아래 "세션 제어 (채널 명령)").

- 위치인자(`<proj>`/`<lane>`)와 `--json` 은 순서 무관하게 어디에 있어도 됩니다 — `--json` 이 `<proj>`/`<lane>` 값으로 오인되지 않습니다.
- **`--json`**: 장부를 JSON 배열로 출력합니다. 각 항목은 `id`/`label`/`createdAt`/`lastActivityAt`/`current`(현재 세션이면 `true`)를 담습니다. 빈 장부는 유효한 빈 배열 `[]` 을 출력합니다(exit 0). `--json` 없이 호출하면 출력·종료 코드가 기존과 동일합니다.

```bash
adde sessions myproj tg-claude --json   # 기계 판독 장부(모니터링/스크립트)
```

## 세션 제어 (채널 명령)

대화 세션의 초기화·압축·재개는 CLI 가 아니라 **채널에서** 지시합니다(진행 중인 턴을 존중해 메시지 큐에 직렬로 처리되고, 결과가 채널 응답으로 통지됩니다).

| 동작                 | 마크다운 (전용 체크박스 라벨) | Telegram (정확 일치)     | 결과                                              |
| -------------------- | ----------------------------- | ------------------------ | ------------------------------------------------- |
| 새 세션 시작(초기화) | `- [x] 🧹 clear`              | `/clear`                 | 엔진을 새 세션으로 재기동 — 이전 대화 맥락 소거   |
| 컨텍스트 압축        | `- [x] compact`               | `/compact`               | 엔진의 압축 명령 실행(대화는 유지, 컨텍스트 축약) |
| 세션 목록            | `- [x] resume`                | `/resume`                | 최근 세션 목록(번호·발췌·마지막 대화 시각) 응답   |
| 세션 재개            | `- [x] resume <번호\|세션id>` | `/resume <번호\|세션id>` | 해당 세션으로 복귀(찾지 못하면 새 세션 폴백 통지) |

- 마크다운 라벨은 send 와 같은 계약입니다: 라벨 정확 일치(앞 이모지 허용), 체크 시 실행, 처리 후 해당 줄이 `✅ sent [[...]]` 로 종단되고 결과 노트가 링크됩니다.
- Telegram 은 메시지 전체가 명령과 **정확히 일치**할 때만 제어로 해석합니다 — 문장 속 `/clear` 는 일반 프롬프트로 전달됩니다. 그룹 채팅의 봇멘션 접미(`/clear@봇이름`·`/compact@봇이름`·`/resume@봇이름 <번호>`)는 허용합니다.
- 레인 재기동(`adde restart`)도 새 세션으로 시작합니다(자동 재개 없음 — 이어가려면 재기동 후 `/resume` 으로 선택 복귀).

## lane — 레인 설정

레인 conf(`lanes.d/<lane>.conf`)를 생성·조회·삭제합니다. 파일 1개 = 레인 1개.

```bash
adde lane add <proj> <lane> [옵션]              # 생성
adde lane set <proj> <lane> --<field> <value>…  # 기존 conf 제자리 편집
adde lane ls <proj>                              # 목록
adde lane show <proj> <lane>                     # conf 출력
adde lane rm <proj> <lane> [--purge]             # conf 삭제 (--purge 시 state/queue/out 도 삭제)
adde lane help                                   # 전체 옵션
```

`ls`/`rm` 은 각각 `list`/`remove` 로도 쓸 수 있습니다(동일 동작).

`lane rm` 은 기본적으로 conf 만 지우고 부수 데이터(state/queue/out)는 보존합니다. `--purge` 를 주면 해당 레인의 `state`/`queue`/`processing`/`out` 디렉터리까지 삭제합니다(고아 데이터 정리). `--purge` 는 state(봇 토큰 `.env` 포함)를 파괴하므로 `proj rm` 과 동일하게 가드됩니다 — **활성 레인이면 거부**(먼저 데몬을 내리거나 `--force`)하고, TTY 에선 레인 이름 재입력으로 확인(비대화형은 `--force` 필요). `--purge` 없는 일반 `lane rm` 에는 이 가드가 없습니다.

### lane add 옵션

| 옵션                                                 | 기본값                                             | 설명                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <markdown\|telegram>`                      | `markdown`                                         | 채널 소스                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--perm-tier <acp\|autopass>`                        | `acp`                                              | 권한 티어. `acp`=전 도구 채널 승인 / `autopass`=denylist 외 자동 허용(옵트인)                                                                                                                                                                                                                                                                                                                                          |
| `--cwd <abs-path>`                                   | (supervisor cwd)                                   | 이 레인 AI 의 작업 폴더(프로젝트 매핑)                                                                                                                                                                                                                                                                                                                                                                                 |
| `--engine-args <args>`                               | (없음)                                             | 엔진 프로세스 spawn 시 전달할 추가 CLI 인자, 공백 분리(예: `--model opus`) — 따옴표·공백 포함 값은 지원하지 않으며(값에 따옴표가 있으면 레인 기동이 거부됨) 엔진 자식 프로세스의 argv 가 되므로 **시크릿·토큰을 담는 용도가 아닙니다**: argv 는 OS 프로세스 목록(`ps` 등)을 볼 수 있는 누구에게나 노출되며, ADDE 의 자체 시크릿 마스킹은 로그·runtime·트랜스크립트만 커버할 뿐 OS 프로세스 목록까지는 가리지 못합니다. |
| `--allowlist <a,b,c>`                                | (없음)                                             | 자동 허용 도구(게이트는 유지, `perm_tier=acp` 용)                                                                                                                                                                                                                                                                                                                                                                      |
| `--denylist <항목,...>`                              | autopass 시 내장 기본 목록(아래 **기본 denylist**) | `autopass` 에서 채널 승인으로 폴백할 도구·패턴 — `Bash`(도구 전체) 또는 `"Bash(git push*)"`(대표 인자 글롭)                                                                                                                                                                                                                                                                                                            |
| `--hard-deny <항목,...>`                             | (없음)                                             | 티어와 무관하게 **즉시 거부**할 도구·패턴(채널 프롬프트조차 없음, conf 키 `hard_deny=`) — `--denylist` 와 같은 형식                                                                                                                                                                                                                                                                                                    |
| `--safe-defaults`                                    | —                                                  | hard-deny 를 내장 위험 목록으로 채움(명시한 `--hard-deny` 와 합집합). 대화형 `lane add`/`init` 이 활성화 여부를 물음(기본 예)                                                                                                                                                                                                                                                                                          |
| `--lang <en\|ko>`                                    | (전역 로케일)                                      | 이 레인의 **채널 메시지** 언어(권한 프롬프트·경고 배너·알림 노트)                                                                                                                                                                                                                                                                                                                                                      |
| `--chat-id <id>`                                     | (없음)                                             | telegram 회신 대상. **개인 chat**(양수)이면 인바운드 자동 허용(그룹=음수는 회신만, 멤버는 `allow_from`)                                                                                                                                                                                                                                                                                                                |
| `--allow-from <ids>`                                 | (없음)                                             | telegram 인바운드 허용 발신자 user id(콤마 구분). 개인 `chat_id` 와 합쳐 인증(그룹 멤버 인증에 필수)                                                                                                                                                                                                                                                                                                                   |
| `--file-mode <private\|shared>`                      | `private`                                          | state/out/queue 디렉터리 권한. `private`=0700(소유자 전용) / `shared`=잠그지 않음(umask 기본, 통상 타 사용자 열람 가능)                                                                                                                                                                                                                                                                                                |
| `--token-stdin`                                      | —                                                  | telegram 봇 토큰을 stdin 에서 읽어 `.env`(0600) 기록                                                                                                                                                                                                                                                                                                                                                                   |
| `--root <abs-path>`                                  | (없음)                                             | markdown 루트(예: Obsidian vault)                                                                                                                                                                                                                                                                                                                                                                                      |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | —                                                  | markdown 노트 경로(root 상대)                                                                                                                                                                                                                                                                                                                                                                                          |
| `--force`                                            | —                                                  | 기존 conf 덮어쓰기                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--interactive`                                      | —                                                  | 대화형 마법사 강제(TTY 전용 — 비TTY 에서는 오류)                                                                                                                                                                                                                                                                                                                                                                       |
| `--no-interactive`                                   | —                                                  | 비대화형 강제(플래그·기본값 사용, 프롬프트 없음) — 스크립트·CI 용                                                                                                                                                                                                                                                                                                                                                      |

**기본 대화형**: TTY 에서 `adde lane add <proj> <lane>` 를 **필드 플래그 없이** 실행하면 대화형 마법사가 자동으로 뜹니다 — `--interactive` 불요. 필드 플래그(`--source`·`--perm-tier`·`--cwd`·`--engine-args`·`--allowlist`·`--denylist`·`--hard-deny`·`--safe-defaults`·`--lang`·`--chat-id`·`--allow-from`·`--file-mode`·`--root`·`--inbox`·`--approvals`·`--outbox`·`--token-stdin`) 중 하나라도 주거나, `--no-interactive` 를 주거나, stdin 이 TTY 가 아니면(스크립트·CI) 비대화형이 됩니다. `--interactive` 는 대화형을 강제하고(비TTY 에서는 오류), `--no-interactive` 는 비대화형을 강제합니다. `<proj>`·`<lane>` 은 항상 필수 위치 인자입니다.

**engine/backend 는 고정값이며 플래그가 아닙니다**: ADDE 는 현재 단일 엔진(`claude-agent-acp`)을 단일 백엔드(`acp`)로만 구동하므로, `lane add` 에는 더 이상 `--engine`/`--backend`/`--acp-version` 플래그가 없습니다(제거됨 — 지원 값이 하나뿐인 노브를 묻는 것은 아무 것도 바꾸지 못하면서 소음만 더했습니다). 레인 conf 의 `engine=`/`backend=`/`acp_version=` 키 자체는 그대로 있으며 레인 기동 시 검증됩니다 — 오타나 미지원 값(conf 수기 편집으로만 가능)은 조용히 무시되는 대신, 미지원 값과 지원 목록을 알리는 오류와 함께 엔진 spawn 전에 거부됩니다.

마법사에서 telegram 봇 토큰은 **마지막에 가려진 입력**(키 입력 비에코)으로 받아 `.env`(0600)에 기록하며, 비워 두면 나중으로 미룹니다(`--token-stdin` 또는 `.env` 직접 편집). 마법사는 `--safe-defaults`(hard-deny 위험 목록) 활성화 여부도 묻습니다(기본 예). **enum 필드는 번호 메뉴로 표시**되어 **번호**(`1`·`2`…)로 답하거나 값을 직접 입력할 수 있습니다 — `source`·`perm_tier`·`file_mode`·`lang` 이 그렇습니다. **경로 필드(`cwd`·`root` 등)는 Tab 디렉터리 자동완성**을 지원합니다. 숫자 필드(`chat_id`·`allow_from`)는 입력 시점에 검증되어 잘못되면 재질의합니다. 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상은 **경고**로 안내하되 생성은 진행됩니다.

**예시: 대화형** (TTY 에서 자동 실행 — 필수 `<proj> <lane>` 뒤로 필드 프롬프트가 이어짐):

```text
$ adde lane add myproj tg-claude
source (번호 또는 값 입력)
  1) markdown
  2) telegram [markdown]: 2
channel [telegram]:
perm_tier (acp = 도구마다 채널 승인 / autopass = denylist 외 자동 허용)
  1) acp
  2) autopass [acp]: 2
allowlist (콤마 구분, 없으면 비움): Read,Grep
denylist (채널 승인으로 폴백할 도구·패턴, 콤마 구분) [Bash(sudo *),…]:
방어심화 하드-거부 기본값을 켤까요? sudo / rm -rf / git 강제 / 자격증명 읽기를 즉시 차단 (y/N) [y]: y
lang (채널 메시지 로케일, 전역은 비움)
  1) en
  2) ko: 2
cwd (레인 작업 폴더 절대경로, 없으면 비움): /Users/me/work/my-project    # Tab 으로 경로 완성
engine_args (엔진 프로세스에 전달할 추가 CLI 인자, 공백 분리, 없으면 비움 — 시크릿은 넣지 마세요: OS 프로세스 목록에 노출됩니다):
file_mode (private=소유자 전용 0700 / shared=umask 기본 유지, 통상 타 사용자 열람)
  1) private
  2) shared [private]:
chat_id (회신 대상 + 해당 chat 인바운드 허용, 없으면 비움): 12345678
allow_from (추가 허용 발신자 id, 콤마 구분, 없으면 비움):
telegram 봇 토큰 (가려진 입력, 나중에 설정하려면 비움): ⟨입력 숨김⟩

레인 "tg-claude" 생성: ~/.config/adde/myproj/lanes.d/tg-claude.conf
토큰 기록: ~/.config/adde/myproj/state/tg-claude/.env (0600)
기동: adde up myproj
```

(`denylist` 프롬프트는 `perm_tier=autopass` 일 때만 나옵니다. `markdown` 소스에서는 `chat_id`/`allow_from`/토큰 프롬프트가 `root`/`inbox`(기본 `inbox.md`)/`approvals`/`outbox` 로 바뀝니다.)

**예시: 스크립트** (비대화형, 모든 값을 플래그로, 토큰은 stdin 으로 — 프롬프트 없음):

```bash
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude \
  --source telegram \
  --cwd /Users/me/work/my-project \
  --perm-tier autopass \
  --denylist "Bash(git push*),Write(/etc/*)" \
  --safe-defaults \
  --hard-deny "Bash(sudo *)" \
  --allowlist Read,Grep \
  --chat-id 12345678 \
  --allow-from 111111,222222 \
  --file-mode private \
  --lang ko \
  --no-interactive \
  --token-stdin
```

`--token-stdin`(또는 임의의 필드 플래그)만으로도 비대화형이 됩니다. `--no-interactive` 는 명시성을 위해 함께 적었으며, stdin 이 여전히 TTY 일 수 있는 CI 에서 확실히 비대화형으로 두려면 이 플래그를 씁니다.

> ⚠️ `--perm-tier autopass` 는 denylist 에 없는 **모든 도구(파일 쓰기·Bash 포함)를 채널 확인 없이 자동 허용**하는 옵트인 모드입니다. 확인이 필요한 도구는 `--denylist` 에 두세요. 자동 허용 내역은 transcript 에 기록되고, 기동 시 채널로 경고 배너가 전송됩니다. 기본값(`acp`)의 동작은 변하지 않습니다.
>
> allowlist/denylist 매칭은 엔진이 알려주는 원시 도구명(예: `Bash`, `Write`) 기준이며, 도구명을 확인할 수 없는 요청은 자동 허용하지 않고 채널 승인으로 보냅니다(fail-closed). 현재 도구명 제공은 `claude-agent-acp` 엔진에서 확인되었습니다 — 도구명을 제공하지 않는 엔진에서는 autopass 여도 모든 요청이 채널 승인을 거칩니다(안전 방향).
>
> **denylist 패턴**: `Tool(글롭)` 형식으로 대표 인자를 매칭합니다 — Bash 는 명령 문자열, Read/Write/Edit 는 파일 경로, WebFetch 는 URL. `*` 는 임의 문자열(경로 구분자 포함)이고 전체 일치 기준이라 접두 차단은 `Bash(git push*)`, 포함 차단은 `Bash(*sudo *)` 처럼 씁니다. 인자를 확인할 수 없는 요청·패턴을 지원하지 않는 도구는 도구명만 맞아도 채널 승인으로 갑니다(과매칭=안전 방향). 도구명 비교는 대소문자를 무시합니다. **셸 체이닝**: Bash 는 체이닝·그룹의 하위 명령을 개별 매칭합니다(`;` `&&` `||` `|` `&`·그룹 `(` `)` `{` `}`·`$(…)`·백틱·개행으로 분리, 선행 `VAR=` 대입 제거) — 접두 패턴(`sudo *`)이 `echo x && sudo y`·`(sudo y)` 를 잡습니다. 완전한 셸 파서가 아닌 best-effort 입니다(alias·`eval`·변수 확장 미해석; `bash -c "sudo y"` 같은 래퍼 호출은 못 잡음; 따옴표 안에서도 연산자로 분리하므로 `--safe-defaults` 에서 인용부 인자에 연산자+위험 토큰이 든 정상 명령이 거부될 수 있음) — 확실한 차단이 필요하면 도구 전체(`Bash`)를 지정하세요.
>
> **기본 denylist**: `--perm-tier autopass` 에서 `--denylist` 를 생략하면 파괴적 셸 명령과 자격증명 저장소 읽기를 승인으로 돌리는 내장 기본 목록을 conf 에 기록합니다 — `Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`. 항목은 목록일 뿐 완전한 방어가 아닙니다(위 셸 체이닝 참고) — 프로젝트에 맞게 조정하세요.
>
> **hard-deny(`--hard-deny`·`--safe-defaults`)**: `--denylist` 와 같은 `Tool(글롭)` 형식이지만 강도가 다릅니다 — denylist 는 `autopass` 에서 자동 허용을 빼고 **채널 승인으로 폴백**하는 반면, hard-deny 는 매칭 요청을 **`perm_tier` 와 무관하게(기본 `acp` 포함) 채널 프롬프트조차 없이 즉시 거부(취소)** 합니다. 파국적 명령이 실수로 승인되는 것을 원천 차단하는 최종 방어선입니다. `--safe-defaults` 는 위 **기본 denylist** 와 동일한 위험 목록을 hard-deny 로 채웁니다(명시한 `--hard-deny` 와 합집합). hard-deny 적중은 transcript 기록 + 채널 통지. 개념·권장 사용은 [권한 가이드](permissions.ko.md#hard-deny-즉시-거부).

> **인바운드 인증(telegram)**: 인바운드 메시지·권한 콜백은 허용 발신자만 처리하고 나머지는 무시합니다(fail-closed). 허용 집합 = **개인 `chat_id`(양수 = 그 사용자, 자기 인증) ∪ `allow_from`**. **그룹 `chat_id`(음수)는 회신 대상일 뿐 멤버를 인증하지 않으므로**, 그룹에서는 허용 멤버 user id 를 `--allow-from` 으로 지정하세요(그룹 chat_id 만으로 그룹 전체가 허용되지 않음). 허용 발신자가 없으면 모든 인바운드가 거부됩니다. 봇에 접근 가능한 임의 사용자가 호스트 실행 세션에 프롬프트를 주입하거나 무단으로 권한을 승인하는 것을 막는 경계입니다.

> **파일 권한(`--file-mode`)**: 기본 `private` 는 레인의 state/out/queue/lanes.d 디렉터리를 0700(소유자 전용)으로 잠가 다중 사용자 호스트에서 타 로컬 사용자의 대화·응답·설정 메타 열람을 차단합니다. `shared` 는 이 잠금을 하지 않는 옵트인(기존 umask 기본 권한 유지 — 통상 0755)으로, 열람 공유가 필요한 경우에만 사용하세요. (봇 토큰 `.env` 는 모드와 무관하게 항상 0600.)
>
> **엔진 크래시 자가 회복(`auto_relaunch`)**: `lane add` 플래그가 아니라 레인 `.conf` 파일에 직접 설정합니다(`auto_relaunch=false`), 이후 `adde restart <proj>`. 기본값은 ON — 핸드셰이크 이후 레인 엔진 프로세스가 크래시하면 ADDE 가 유계 지수 백오프로 재기동하며 동일 세션·구독자·권한 핸들러를 승계합니다. `auto_relaunch=false` 는 **자동 재기동만** 비활성화합니다 — 크래시 감지, 즉시 `error` 상태 표기, 크래시 시점에 대기 중이던 권한 요청의 거부 종결, 채널 통지 1회는 그대로 수행됩니다. [문제해결](troubleshooting.ko.md#엔진-크래시--자가-회복) 참조. (이는 _엔진_ 프로세스에 대한 레인별 설정이며, _데몬_ 프로세스 자체에 대응하는 프로젝트별 설정은 [`proj.conf` 의 `auto_restart`](#projconf--데몬-크래시-자동-재기동)입니다.)

### lane set — 기존 레인 conf 제자리 편집

```bash
adde lane set <proj> <lane> --<field> <value> …
```

기존 레인을 삭제·재생성하지 않고 conf 를 편집합니다(state/queue/토큰 유실 없음). 지정하지 않은 필드는 기존 값을 유지합니다.

| 옵션                                                    | 비고                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--perm-tier <acp\|autopass>`                           | `lane add` 와 동일                                                                                   |
| `--cwd <abs-path>`                                      | `lane add` 와 동일                                                                                   |
| `--engine-args <args>`                                  | `lane add` 와 동일(공백 분리, 편집 시 재검증)                                                        |
| `--allowlist <a,b,c>`                                   | **전체 목록을 치환**(병합 아님) — 생략하면 변경 없음                                                 |
| `--denylist <항목,...>`                                 | **전체 목록을 치환**(병합 아님)                                                                       |
| `--hard-deny <항목,...>`                                | **전체 목록을 치환**(병합 아님) — 기존 목록이 비어있지 않았으면 경고 출력                             |
| `--lang <en\|ko>`                                       | `lane add` 와 동일                                                                                   |
| `--file-mode <private\|shared>`                         | conf 값만 갱신 — 실 디렉터리 권한은 다음 `adde restart` 시점에 재적용됩니다(즉시 반영 아님)          |
| `--chat-id <id>` `--allow-from <ids>`                   | telegram 레인 전용 — markdown 레인에서는 거부됨                                                     |
| `--root <abs-path>` `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | markdown 레인 전용 — telegram 레인에서는 거부됨                                 |

**편집 불가**: `--source`/`--backend`/`--engine`/`--acp-version`(레인 정체성)·봇 토큰·`--safe-defaults` 는 `lane set` 플래그가 아닙니다. 정체성 플래그를 지정하면(단순 미지원 플래그 오류가 아니라) "레인을 재생성하라"는 전용 오류로 거부됩니다 — 이 필드들을 바꾸려면 레인을 재생성(`adde lane rm` 후 `adde lane add`)하세요. hard-deny 위험 목록을 바꾸려면 `--safe-defaults` 대신 `--hard-deny` 를 직접 편집하세요.

**`lane add` 와 동일한 검증**: 편집된 conf 전체가(engine/backend 배선·소스별 검증·필드 형식) 기록 전에 재검증됩니다 — 검증에 실패하면 기존 conf 파일은 바이트 단위로 그대로 남습니다(validate-then-commit, 원자 쓰기). `--denylist` 없이 `--perm-tier autopass` 로 편집하고 현재 denylist 가 비어 있으면, `lane add` 와 동일하게 내장 기본 denylist 를 자동 충전하고 동일한 autopass 경고 배너를 출력합니다. 현재 소스와 맞지 않는 필드(예: markdown 레인에 `--chat-id`)는 하드 거부됩니다.

**변경은 재기동이 필요합니다**: 데몬은 레인 conf 를 기동 시에만 로딩하므로 편집은 실행 중인 레인에 즉시 반영되지 않습니다 — 데몬 실행 여부와 무관하게 `lane set` 은 항상 `adde restart <proj>` 안내를 출력합니다.

```bash
adde lane set myproj tg-claude --perm-tier autopass --hard-deny "Bash(sudo *)"
adde restart myproj
```

## proj — 프로젝트 목록·삭제

프로젝트 단위 뷰·정리(`lane`·`status` 의 레인 중심 뷰와 상보).

```bash
adde proj ls                    # 등록된 프로젝트 목록(레인·실행 수 포함)
adde proj rm <proj> [--force]   # 프로젝트 삭제: 모든 레인 + state
```

`ls`/`rm` 은 `list`/`remove` 로도 쓸 수 있습니다.

- **`proj ls`** — 등록된 프로젝트(설정 base 아래 `lanes.d/` 를 가진 디렉터리)마다 한 행으로 레인 수·실행 수를 출력. `--json` 은 스크립트용 배열.
- **`proj rm <proj>`** — 프로젝트 디렉터리 전체(`lanes.d` + `state` + `queue` + `processing` + `out`)를 삭제합니다. 파괴적이므로:
  - 실행 중/dead/stale 레인이 있으면 **거부**합니다 — 먼저 데몬을 내리거나(`adde down <proj>`) `--force` 로 강제 삭제;
  - TTY 에선 **프로젝트 이름 재입력**으로 확인하고, 비대화형 셸에선 `--force` 가 필요합니다;
  - 삭제 전 **launchd 데몬을 unload** 해 고아 plist 등록이 남지 않게 합니다.

```bash
adde proj ls                    # PROJECT · LANES · RUNNING 표
adde down myproj                # 실행 중이면 먼저 정지
adde proj rm myproj             # 이름 재입력으로 확인
adde proj rm myproj --force     # 확인 생략(스크립트·CI)
```

## completion — 셸 자동완성

```bash
adde completion <bash|zsh>
```

명령·플래그 자동완성 스크립트를 stdout 으로 출력합니다(맥 기본 zsh + bash 지원) — **설치는 하지 않습니다**(셸 자동완성 디렉터리로 직접 리다이렉트). 명령/플래그 스펙에서 생성되므로 명령이 늘면 자동완성도 함께 갱신됩니다. 스크립트는 `adde` 와 짧은 별칭 `ad`·`add` 를 함께 등록합니다. `adde completion --help` 가 셸별 왜/무엇/어디에를 설명하며, **`adde init` 이 설치를 단계별로 안내**합니다(별칭 단계 직후, 옵트인). 터미널에서 바로 실행하면(리다이렉트 아님) 설치 힌트를 stderr 로도 출력합니다.

```bash
# zsh: compinit 후 fpath 에 두거나 .zshrc 에서 source
adde completion zsh > "${fpath[1]}/_adde"   # 또는: adde completion zsh >> ~/.zshrc 후 재로그인

# bash: bash-completion 디렉터리에 두거나 .bashrc 에서 source
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

**완성 대상**:

- **최상위 명령 + 전역 플래그** — `up`/`down`/…/`lane`/`completion`, `-h`/`--help`/`-v`/`--version`. zsh 는 각 명령 옆에 짧은 설명을 표시합니다.
- **하위 명령·고정 값** — `lane add|set|ls|show|rm|help`, `proj ls|rm`(`proj rm` 뒤 프로젝트 이름), `completion bash|zsh`, `alias` 뒤 별칭 이름 제안, `status --all/--json`, `logs --engine`, `lane add`/`lane set` 옵션 플래그(동일 명령 스펙에서 파생되므로 `lane set` 플래그도 동일하게 완성됩니다).
- **동적 프로젝트/레인 이름** — `${ADDE_HOME:-~/.config/adde}` 를 셸에서 직접 스캔합니다(`adde` 프로세스 미스폰): `up`/`down`/`restart`/`status`/`doctor`/`logs`/`sessions` 와 `lane ls|show|rm|add` 의 첫 위치에서 프로젝트 이름(예: `adde up <TAB>`, `adde status <TAB>`), 다음 위치에서 레인 이름(예: `adde logs <proj> <TAB>`, `adde lane show <proj> <TAB>`, `adde sessions <proj> <TAB>`).
- **enum 플래그 값** — `--source`(markdown|telegram), `--perm-tier`(acp|autopass), `--file-mode`(private|shared), `--lang`(en|ko) 뒤.
- **디렉터리 경로** — `--cwd`·`--root` 뒤.

미지원 셸은 오류 + 종료 코드 1.

## 도움말·오타 힌트

- `adde <command> --help`(또는 `-h`) — 해당 명령의 사용법을 출력하고 종료 코드 0. `adde lane <sub> --help` 는 lane 전체 옵션을 출력합니다.
- 오타 등 **미지원 명령**은 stderr 에 `Unknown command` + 근접 명령 추정(`Did you mean: …?`)을 출력하고 종료 코드 1(스크립트에서 오타가 조용히 성공 처리되는 것 방지).
- 그 명령(또는 하위 명령)에 선언되지 않은 **미지원 플래그**는 오류 메시지 + 해당 명령의 사용법(명령이 식별되지 않았으면 전체 사용법)을 stderr 에 출력하고 종료 코드 1 을 반환합니다 — 예: `adde doctor --nonsense`(`[behavior-change]` — 기존에는 이런 플래그를 조용히 무시하고 정상 진행했습니다).

## 종료 코드

| 명령         | 0                                | 1                                                                                                                 |
| ------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `up`         | 데몬 등록 성공                   | launchd 등록 실패·인자 누락                                                                                       |
| `down`       | 데몬 종료 성공(이미 없어도 0)    | 오류 발생                                                                                                         |
| `restart`    | down+up 성공 + 전 레인 기동 성공 | down/up 실패, 또는 레인 1개 이상 기동 실패(`[behavior-change]` — 기존: 재등록 자체가 예외를 던지지 않으면 항상 0) |
| `status`     | 모두 정상                        | `dead`(크래시)·`stale`(행)·`error` 레인 존재, **또는 프로젝트가 크래시루프 자가정지(`halt`) 상태**                |
| `doctor`     | FAIL 없음(`--json` 도 동일)      | FAIL 항목 존재(`--json` 도 동일)                                                                                  |
| `logs`       | 읽기 성공(파일 없어도 안내 후 0) | proj/lane 인자 누락·경로 검증 오류                                                                                |
| `init`       | 마법사 완료                      | 비TTY·인자 누락·검증/생성 오류                                                                                    |
| `alias`      | 별칭 설치·이미 설정 확인         | `adde` PATH 미발견·설치 실패                                                                                      |
| `lane *`     | 성공                             | 인자 누락·검증 오류                                                                                               |
| `completion` | 스크립트 출력                    | 셸 인자 누락·미지원 셸                                                                                            |

인자 없이 실행하거나 `-h`/`--help`/`help` 는 사용법을 출력하고 `0` 을 반환합니다. **미지원 명령**(오타 등)은 stderr 에 `Unknown command` 를 출력하고 `1` 을 반환합니다(스크립트에서 오타가 조용히 성공으로 처리되는 것을 막음).

## 언어(로케일)

CLI 출력·채널 메시지는 en/ko 두 언어를 지원합니다.

- **결정 순서**: `ADDE_LANG`(명시) > `LC_ALL` > `LC_MESSAGES` > `LANG`(언어 코드 파싱, `ko*`→한국어) > 기본 **영어**. 한국어 macOS(`LANG=ko_KR.UTF-8`)에서는 별도 설정 없이 한국어로 출력됩니다.
- **레인별 채널 언어**: `adde lane add --lang <en|ko>`(또는 conf `lang=`) 로 그 레인의 채널 메시지(권한 프롬프트·경고 배너·알림 노트) 언어를 고정할 수 있습니다. 미지정 시 데몬 프로세스의 전역 로케일을 따릅니다.
- **주의(launchd 데몬)**: launchd 로 기동된 데몬은 셸의 `LANG` 을 상속하지 않을 수 있습니다 — 채널 메시지 언어를 확실히 하려면 레인 conf 에 `lang=` 을 지정하세요.

## 경로

- 설정 base: `~/.config/adde`(환경변수 `ADDE_HOME` 로 변경 가능).
- 프로젝트: `<base>/<proj>/`.
- 레인 conf: `<base>/<proj>/lanes.d/<lane>.conf`.
- 레인 상태: `<base>/<proj>/state/<lane>/`(`.env`·`session.id`·`sessions.json`(세션 장부)·`transcript.log`·`engine.log`·`runtime.json`).
- launchd plist: `~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist` (macOS 전용, `adde up` 이 생성·관리).

## macOS 전용 기능

`adde up`/`down`/`restart` 의 데몬 관리 기능은 macOS launchd에 의존합니다. Linux/WSL 환경에서는 이 명령들이 오류를 반환합니다.

**재부팅 자동복구**: `adde up` 으로 등록한 데몬은 macOS 재부팅·로그아웃 후에는 (`proj.conf` 의 `auto_restart` 값과 무관하게) **항상** 재기동됩니다(`RunAtLoad`). 크래시 자동 재기동(`KeepAlive`, 비정상 종료·치명적 시그널)은 별개이며 최소 60초 간격으로 제한됩니다 — [크래시 전용 자동 재기동](#up--레인-기동-데몬)·[`proj.conf`](#projconf--데몬-크래시-자동-재기동) 참조. 재부팅 후 `adde status <proj>` 로 복구를 직접 확인하는 것을 권장합니다.

**운영 검증 체크리스트**: 아래 항목은 자동 검증 범위 밖으로, 실 macOS 환경에서 직접 확인해야 합니다.

1. `adde up <proj>` → 터미널 종료 → 새 터미널에서 `adde status <proj>` 가 `running` 인지 확인
2. 다른 터미널에서 `adde down <proj>` 후 `adde status <proj>` 가 `stopped` 인지 확인
3. macOS 재부팅 후 `adde status <proj>` — 자동 복구 확인
4. `adde up <proj>` 연속 두 번 실행 — 이중 기동 없음 확인(경고 메시지 출력 후 스킵)
5. `adde down <proj>` 후 `ps aux | grep claude-agent-acp` — orphan 프로세스 없음 확인
6. 데몬 프로세스에 수동으로 `SIGTERM` 을 보내 graceful shutdown 을 완주시키기 — launchd 가 재기동**하지 않는지** 확인(크래시·`kill -9` 는 재기동되어야 하며 이와 구분)
7. `proj.conf` 에 `auto_restart=false` 설정 후 데몬 크래시(예: `kill -9`) — launchd 가 재기동하지 않고 `adde status`/`adde doctor <proj>` 가 "등록됨-미실행"(거짓 `running` 아님)으로 표면화하는지 확인
8. 모든 레인 conf 를 무효/누락 설정으로 만들어 데몬이 실행 중 레인 0개로 부팅되게 하기 — 무한 루프 없이 정상 종료하고 `adde up <proj>` 가 실패를 보고하는지 확인
9. 기동 직후 짧은-수명 크래시를 반복 유발(60초 미만 생존을 5회 이상 연속) — 데몬이 자가 정지하고 `adde status`/`adde doctor <proj>` 가 이를 보고하는지, 이후 `adde restart <proj>` 로 정지 상태가 초기화되어 정상 기동을 다시 밟는지 확인
