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
- [status — 레인 상태](#status--레인-상태)
- [doctor — 환경 점검](#doctor--환경-점검)
- [logs — 최근 활동](#logs--최근-활동)
- [sessions — 세션 목록](#sessions--세션-목록)
- [세션 제어 (채널 명령)](#세션-제어-채널-명령)
- [lane — 레인 설정](#lane--레인-설정)
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

인자 없이 `adde` 를 실행하거나 `-h`/`--help`/`help` 는 전체 사용법을 출력합니다. 특정 명령의 도움말은 `adde <command> --help` (예: `adde status --help`, `adde lane add --help`).

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
  ✔ ACP 어댑터 바이너리: @zed-industries/claude-code-acp 해석됨
  ✔ 설정 base 디렉터리: ~/.config/adde
  ✔ 데몬 진입 파일: /opt/homebrew/lib/node_modules/adde/dist/cli/adde.js

짧은 별칭(ad, add)을 adde 명령 옆에 설치할까요? (Y/n) [y]: y
  ✔ 별칭 생성: ad → /usr/local/bin
  ✔ 별칭 생성: add → /usr/local/bin

프로젝트 이름 [default]: myproj
레인 이름 [main]: tg-claude
source (telegram 또는 markdown) [telegram]: telegram
engine [claude-code-acp]:
backend [acp]:
channel [telegram]:
perm_tier (acp 또는 autopass) [acp]:
acp_version [v1]:
allowlist (콤마 구분, 없으면 비움): Read,Grep
방어심화 하드-거부 기본값을 켤까요? sudo / rm -rf / git 강제 / 자격증명 읽기를 즉시 차단 (y/N) [y]: y
lang (채널 메시지 로케일: en/ko, 전역은 비움):
cwd (레인 작업 폴더 절대경로, 없으면 비움): /Users/me/work/my-project
chat_id (회신 대상 + 해당 chat 인바운드 허용, 없으면 비움): 12345678
allow_from (추가 허용 발신자 id, 콤마 구분, 없으면 비움):
file_mode (private=소유자 전용 0700 / shared=umask 기본 유지, 통상 타 사용자 열람) [private]:
telegram 봇 토큰 (가려진 입력, 나중에 설정하려면 비움): ⟨입력 숨김⟩

레인 "tg-claude" 생성: ~/.config/adde/myproj/lanes.d/tg-claude.conf
토큰 기록: ~/.config/adde/myproj/state/tg-claude/.env (0600)

프로젝트 'myproj' 설정 완료.
기동: adde up myproj
```

빈 응답은 표시된 기본값(`[…]`)을 채택합니다. `engine`·`backend`·`channel`·`acp_version` 프롬프트는 로케일과 무관하게 영문으로 표시됩니다. 토큰을 비워 두면 마지막 두 줄이 `토큰 기록` 대신 `다음: 봇 토큰을 …/.env 에 TELEGRAM_BOT_TOKEN=... 으로 두세요` 안내가 됩니다. `markdown` 소스에서는 `chat_id`/`allow_from`/토큰 프롬프트가 `root`/`inbox`/`approvals`/`outbox` 로 바뀝니다.

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

| 상태      | 의미                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `running` | 상태 파일이 있고 기동 프로세스(pid)가 살아있으며 하트비트가 신선함     |
| `stale`   | pid 는 살아있으나 하트비트(상태 파일 mtime)가 끊김 — **행(hung) 의심** |
| `dead`    | 상태 파일이 있으나 프로세스가 없음 — **비정상 종료(크래시) 잔존**      |
| `stopped` | 상태 파일 없음 — 정상 종료 또는 미기동                                 |

- **`<proj>` 지정**: 해당 프로젝트의 모든 레인(정지 포함)을 `LANE · STATUS · PID · UPTIME · SEEN · SOURCE` 표로 출력.
- **`<proj>` 생략**: 전 프로젝트(`~/.config/adde/*/`)를 집계해 **실행 중(정지 제외) 레인**을 `PROJECT · LANE · …` 표로 출력. 실행 중 레인이 없으면 안내 메시지.
- **`--all`**(`<proj>` 생략 시): 정지(`stopped`) 포함 전 레인을 표시.
- `dead`·`stale` 레인이 있으면 조치 안내를 덧붙입니다(`SEEN` = 마지막 하트비트 경과).
- 하트비트: `adde up` 이 주기적으로 상태 파일 mtime 을 갱신합니다. pid 가 살아있어도 갱신이 임계 시간 멈추면 `stale`(행) 로 판정합니다.
- `--json`: 레인 객체 배열(모니터링/스크립트용, `lastSeenAt` 포함; 집계 시 `proj` 부기).
- **업데이트 안내**: npm 에 새 버전이 있으면 안내 한 줄(`npm i -g adde-acp@latest` … 후 `adde restart`)을 덧붙입니다. 24시간 캐시(설정 base 하위)를 쓰며, 대화형 터미널(TTY)에서만 네트워크를 조회하고, `ADDE_NO_UPDATE_CHECK` 환경변수로 끌 수 있습니다.
- 읽기 전용(부수효과 없음).

```bash
adde status myproj          # 한 프로젝트의 레인별 표(정지 포함)
adde status --all           # 전 프로젝트, 정지 레인 포함
adde status myproj --json   # 기계 판독 배열(모니터링/스크립트)
```

## doctor — 환경 점검

```bash
adde doctor [<proj>]
```

상태와 무관한 정적 점검을 수행하고 각 항목을 `PASS` / `WARN` / `FAIL` 로 보고합니다. 실패·경고에는 조치 힌트(`↳ 조치:`)가 붙습니다.

- 전역: Node 버전(≥22) · ACP 어댑터 바이너리 해석 · 설정 base 디렉터리 · (macOS) 데몬 진입 파일 해석.
- `<proj>` 지정 시 레인별: source 유효성 · `cwd` 존재 · (telegram) `.env` 토큰 존재.
- **파일 권한 점검**(`<proj>` 지정 시 레인별): `state/<lane>/.env` 가 그룹/기타 사용자에게 열려 있으면(기대 0600 — 봇 토큰 노출 위험) `WARN`, `file_mode=private` 인데 `state/<lane>` 디렉터리가 그룹/기타 사용자에게 열려 있으면(기대 0700) `WARN` 하고 `chmod`/`adde restart` 힌트를 붙입니다. `file_mode=shared` 는 의도된 선택으로 보고 경고하지 않습니다.
- `<proj>` 지정 시 macOS에서는 launchd 데몬 등록 상태도 점검합니다 — plist 존재 여부와 launchctl 등록 여부를 교차 확인하고, 불일치(plist는 있으나 launchd 미등록, 또는 그 역)를 `WARN`으로 표면화합니다.
- **업데이트 안내**: `status` 와 동일하게, npm 에 새 버전이 있으면 안내 한 줄을 표시합니다(24시간 캐시·TTY 에서만 조회·`ADDE_NO_UPDATE_CHECK` 로 비활성).
- 읽기 전용. 기동 전 "왜 안 뜨나"를 자가 진단하는 용도입니다.

## logs — 최근 활동

```bash
adde logs <proj> <lane> [N] [--engine]
```

해당 레인의 `transcript.log`(ACP 세션 이벤트 기록) 최근 `N` 줄을 출력합니다(기본 50). 파일이 없으면 안내를 출력합니다.

- `N`: 출력할 마지막 줄 수(기본 50).
- `--engine`: transcript 대신 `engine.log`(엔진 서브프로세스 stderr 캡처)를 출력합니다. 엔진 자체의 진단 출력을 볼 때 사용합니다(`stale`/기동 실패 원인 추적 등).

```bash
adde logs myproj tg-claude 100 --engine   # 엔진 stderr 로그 마지막 100줄
```

## sessions — 세션 목록

```bash
adde sessions <proj> <lane>
```

레인의 엔진 세션 장부를 출력합니다 — 번호·첫 프롬프트 발췌·**마지막 대화 시각**·세션 id(현재 세션은 `◀` 표시). 세션 재개·초기화는 채널에서 수행합니다(아래 "세션 제어 (채널 명령)").

## 세션 제어 (채널 명령)

대화 세션의 초기화·압축·재개는 CLI 가 아니라 **채널에서** 지시합니다(진행 중인 턴을 존중해 메시지 큐에 직렬로 처리되고, 결과가 채널 응답으로 통지됩니다).

| 동작                 | Telegram (정확 일치)     | 마크다운 (전용 체크박스 라벨) | 결과                                              |
| -------------------- | ------------------------ | ----------------------------- | ------------------------------------------------- |
| 새 세션 시작(초기화) | `/clear`                 | `- [x] 🧹 clear`              | 엔진을 새 세션으로 재기동 — 이전 대화 맥락 소거   |
| 컨텍스트 압축        | `/compact`               | `- [x] compact`               | 엔진의 압축 명령 실행(대화는 유지, 컨텍스트 축약) |
| 세션 목록            | `/resume`                | `- [x] resume`                | 최근 세션 목록(번호·발췌·마지막 대화 시각) 응답   |
| 세션 재개            | `/resume <번호\|세션id>` | `- [x] resume <번호\|세션id>` | 해당 세션으로 복귀(찾지 못하면 새 세션 폴백 통지) |

- Telegram 은 메시지 전체가 명령과 **정확히 일치**할 때만 제어로 해석합니다 — 문장 속 `/clear` 는 일반 프롬프트로 전달됩니다. 그룹 채팅의 봇멘션 접미(`/clear@봇이름`·`/compact@봇이름`·`/resume@봇이름 <번호>`)는 허용합니다.
- 마크다운 라벨은 send 와 같은 계약입니다: 라벨 정확 일치(앞 이모지 허용), 체크 시 실행, 처리 후 해당 줄이 `✅ sent [[...]]` 로 종단되고 결과 노트가 링크됩니다.
- 레인 재기동(`adde restart`)도 새 세션으로 시작합니다(자동 재개 없음 — 이어가려면 재기동 후 `/resume` 으로 선택 복귀).

## lane — 레인 설정

레인 conf(`lanes.d/<lane>.conf`)를 생성·조회·삭제합니다. 파일 1개 = 레인 1개.

```bash
adde lane add <proj> <lane> [옵션]   # 생성
adde lane ls <proj>                  # 목록
adde lane show <proj> <lane>         # conf 출력
adde lane rm <proj> <lane>           # 삭제 (state/queue 등 부수 데이터는 보존)
adde lane help                       # 전체 옵션
```

`ls`/`rm` 은 각각 `list`/`remove` 로도 쓸 수 있습니다(동일 동작).

### lane add 옵션

| 옵션                                                 | 기본값                                             | 설명                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--source <telegram\|markdown>`                      | `telegram`                                         | 채널 소스                                                                                                                     |
| `--engine <name>`                                    | `claude-code-acp`                                  | ACP 엔진 프로필                                                                                                               |
| `--backend <name>`                                   | `acp`                                              | 백엔드                                                                                                                        |
| `--channel <name>`                                   | source 값                                          | 게이트 분기                                                                                                                   |
| `--perm-tier <acp\|autopass>`                        | `acp`                                              | 권한 티어. `acp`=전 도구 채널 승인 / `autopass`=denylist 외 자동 허용(옵트인)                                                 |
| `--acp-version <v>`                                  | `v1`                                               | ACP 버전                                                                                                                      |
| `--cwd <abs-path>`                                   | (supervisor cwd)                                   | 이 레인 AI 의 작업 폴더(프로젝트 매핑)                                                                                        |
| `--allowlist <a,b,c>`                                | (없음)                                             | 자동 허용 도구(게이트는 유지, `perm_tier=acp` 용)                                                                             |
| `--denylist <항목,...>`                              | autopass 시 내장 기본 목록(아래 **기본 denylist**) | `autopass` 에서 채널 승인으로 폴백할 도구·패턴 — `Bash`(도구 전체) 또는 `"Bash(git push*)"`(대표 인자 글롭)                   |
| `--hard-deny <항목,...>`                             | (없음)                                             | 티어와 무관하게 **즉시 거부**할 도구·패턴(채널 프롬프트조차 없음, conf 키 `hard_deny=`) — `--denylist` 와 같은 형식           |
| `--safe-defaults`                                    | —                                                  | hard-deny 를 내장 위험 목록으로 채움(명시한 `--hard-deny` 와 합집합). 대화형 `lane add`/`init` 이 활성화 여부를 물음(기본 예) |
| `--lang <en\|ko>`                                    | (전역 로케일)                                      | 이 레인의 **채널 메시지** 언어(권한 프롬프트·경고 배너·알림 노트)                                                             |
| `--chat-id <id>`                                     | (없음)                                             | telegram 회신 대상. **개인 chat**(양수)이면 인바운드 자동 허용(그룹=음수는 회신만, 멤버는 `allow_from`)                       |
| `--allow-from <ids>`                                 | (없음)                                             | telegram 인바운드 허용 발신자 user id(콤마 구분). 개인 `chat_id` 와 합쳐 인증(그룹 멤버 인증에 필수)                          |
| `--file-mode <private\|shared>`                      | `private`                                          | state/out/queue 디렉터리 권한. `private`=0700(소유자 전용) / `shared`=잠그지 않음(umask 기본, 통상 타 사용자 열람 가능)       |
| `--token-stdin`                                      | —                                                  | telegram 봇 토큰을 stdin 에서 읽어 `.env`(0600) 기록                                                                          |
| `--root <abs-path>`                                  | (없음)                                             | markdown 루트(예: Obsidian vault)                                                                                             |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | —                                                  | markdown 노트 경로(root 상대)                                                                                                 |
| `--force`                                            | —                                                  | 기존 conf 덮어쓰기                                                                                                            |
| `--interactive`                                      | —                                                  | 대화형 마법사 강제(TTY 전용 — 비TTY 에서는 오류)                                                                              |
| `--no-interactive`                                   | —                                                  | 비대화형 강제(플래그·기본값 사용, 프롬프트 없음) — 스크립트·CI 용                                                             |

**기본 대화형**: TTY 에서 `adde lane add <proj> <lane>` 를 **필드 플래그 없이** 실행하면 대화형 마법사가 자동으로 뜹니다 — `--interactive` 불요. 필드 플래그(`--source`·`--engine`·`--backend`·`--channel`·`--perm-tier`·`--acp-version`·`--cwd`·`--allowlist`·`--denylist`·`--hard-deny`·`--safe-defaults`·`--lang`·`--chat-id`·`--allow-from`·`--file-mode`·`--root`·`--inbox`·`--approvals`·`--outbox`·`--token-stdin`) 중 하나라도 주거나, `--no-interactive` 를 주거나, stdin 이 TTY 가 아니면(스크립트·CI) 비대화형이 됩니다. `--interactive` 는 대화형을 강제하고(비TTY 에서는 오류), `--no-interactive` 는 비대화형을 강제합니다. `<proj>`·`<lane>` 은 항상 필수 위치 인자입니다.

마법사에서 telegram 봇 토큰은 **마지막에 가려진 입력**(키 입력 비에코)으로 받아 `.env`(0600)에 기록하며, 비워 두면 나중으로 미룹니다(`--token-stdin` 또는 `.env` 직접 편집). 마법사는 `--safe-defaults`(hard-deny 위험 목록) 활성화 여부도 묻습니다(기본 예). enum·숫자 필드는 입력 시점에 검증되어 잘못되면 재질의합니다 — `perm_tier`(acp|autopass)·`file_mode`(private|shared)·`lang`(en|ko 또는 빈값)·`chat_id`(숫자 또는 빈값)·`allow_from`(콤마 구분 숫자 또는 빈값)·`source`(telegram|markdown). 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상은 **경고**로 안내하되 생성은 진행됩니다.

**예시: 대화형** (TTY 에서 자동 실행 — 필수 `<proj> <lane>` 뒤로 필드 프롬프트가 이어짐):

```text
$ adde lane add myproj tg-claude
source (telegram 또는 markdown) [telegram]: telegram
engine [claude-code-acp]:
backend [acp]:
channel [telegram]:
perm_tier (acp 또는 autopass) [acp]: autopass
acp_version [v1]:
allowlist (콤마 구분, 없으면 비움): Read,Grep
denylist (채널 승인으로 폴백할 도구·패턴, 콤마 구분) [Bash(sudo *),Bash(rm -rf /*),Bash(rm -rf ~*),Bash(rm -rf .*),Bash(git push --force*),Bash(git push -f*),Bash(git reset --hard*),Bash(git clean -fd*),Read(~/.ssh/**),Read(~/.aws/**),Read(~/.npmrc),Read(~/.config/gh/hosts.yml),Read(~/.kube/config),Read(~/.docker/config.json),Read(~/.config/gcloud/**)]:
방어심화 하드-거부 기본값을 켤까요? sudo / rm -rf / git 강제 / 자격증명 읽기를 즉시 차단 (y/N) [y]: y
lang (채널 메시지 로케일: en/ko, 전역은 비움): ko
cwd (레인 작업 폴더 절대경로, 없으면 비움): /Users/me/work/my-project
chat_id (회신 대상 + 해당 chat 인바운드 허용, 없으면 비움): 12345678
allow_from (추가 허용 발신자 id, 콤마 구분, 없으면 비움):
file_mode (private=소유자 전용 0700 / shared=umask 기본 유지, 통상 타 사용자 열람) [private]:
telegram 봇 토큰 (가려진 입력, 나중에 설정하려면 비움): ⟨입력 숨김⟩

레인 "tg-claude" 생성: ~/.config/adde/myproj/lanes.d/tg-claude.conf
토큰 기록: ~/.config/adde/myproj/state/tg-claude/.env (0600)
기동: adde up myproj
```

(`denylist` 프롬프트는 `perm_tier=autopass` 일 때만 나옵니다. `markdown` 소스에서는 `chat_id`/`allow_from`/토큰 프롬프트가 `root`/`inbox`(기본 `inbox.md`)/`approvals`/`outbox` 로 바뀝니다. `source`·`engine`·`backend`·`channel`·`perm_tier`·`acp_version` 프롬프트는 로케일과 무관하게 영문입니다.)

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
> allowlist/denylist 매칭은 엔진이 알려주는 원시 도구명(예: `Bash`, `Write`) 기준이며, 도구명을 확인할 수 없는 요청은 자동 허용하지 않고 채널 승인으로 보냅니다(fail-closed). 현재 도구명 제공은 `claude-code-acp` 엔진에서 확인되었습니다 — 도구명을 제공하지 않는 엔진에서는 autopass 여도 모든 요청이 채널 승인을 거칩니다(안전 방향).
>
> **denylist 패턴**: `Tool(글롭)` 형식으로 대표 인자를 매칭합니다 — Bash 는 명령 문자열, Read/Write/Edit 는 파일 경로, WebFetch 는 URL. `*` 는 임의 문자열(경로 구분자 포함)이고 전체 일치 기준이라 접두 차단은 `Bash(git push*)`, 포함 차단은 `Bash(*sudo *)` 처럼 씁니다. 인자를 확인할 수 없는 요청·패턴을 지원하지 않는 도구는 도구명만 맞아도 채널 승인으로 갑니다(과매칭=안전 방향). 도구명 비교는 대소문자를 무시합니다. **셸 체이닝**: Bash 는 체이닝·그룹의 하위 명령을 개별 매칭합니다(`;` `&&` `||` `|` `&`·그룹 `(` `)` `{` `}`·`$(…)`·백틱·개행으로 분리, 선행 `VAR=` 대입 제거) — 접두 패턴(`sudo *`)이 `echo x && sudo y`·`(sudo y)` 를 잡습니다. 완전한 셸 파서가 아닌 best-effort 입니다(alias·`eval`·변수 확장 미해석; `bash -c "sudo y"` 같은 래퍼 호출은 못 잡음; 따옴표 안에서도 연산자로 분리하므로 `--safe-defaults` 에서 인용부 인자에 연산자+위험 토큰이 든 정상 명령이 거부될 수 있음) — 확실한 차단이 필요하면 도구 전체(`Bash`)를 지정하세요.
>
> **기본 denylist**: `--perm-tier autopass` 에서 `--denylist` 를 생략하면 파괴적 셸 명령과 자격증명 저장소 읽기를 승인으로 돌리는 내장 기본 목록을 conf 에 기록합니다 — `Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`. 항목은 목록일 뿐 완전한 방어가 아닙니다(위 셸 체이닝 참고) — 프로젝트에 맞게 조정하세요.
>
> **hard-deny(`--hard-deny`·`--safe-defaults`)**: `--denylist` 와 같은 `Tool(글롭)` 형식이지만 강도가 다릅니다 — denylist 는 `autopass` 에서 자동 허용을 빼고 **채널 승인으로 폴백**하는 반면, hard-deny 는 매칭 요청을 **`perm_tier` 와 무관하게(기본 `acp` 포함) 채널 프롬프트조차 없이 즉시 거부(취소)** 합니다. 파국적 명령이 실수로 승인되는 것을 원천 차단하는 최종 방어선입니다. `--safe-defaults` 는 위 **기본 denylist** 와 동일한 위험 목록을 hard-deny 로 채웁니다(명시한 `--hard-deny` 와 합집합). hard-deny 적중은 transcript 기록 + 채널 통지. 개념·권장 사용은 [권한 가이드](permissions.ko.md#hard-deny-즉시-거부).

> **인바운드 인증(telegram)**: 인바운드 메시지·권한 콜백은 허용 발신자만 처리하고 나머지는 무시합니다(fail-closed). 허용 집합 = **개인 `chat_id`(양수 = 그 사용자, 자기 인증) ∪ `allow_from`**. **그룹 `chat_id`(음수)는 회신 대상일 뿐 멤버를 인증하지 않으므로**, 그룹에서는 허용 멤버 user id 를 `--allow-from` 으로 지정하세요(그룹 chat_id 만으로 그룹 전체가 허용되지 않음). 허용 발신자가 없으면 모든 인바운드가 거부됩니다. 봇에 접근 가능한 임의 사용자가 호스트 실행 세션에 프롬프트를 주입하거나 무단으로 권한을 승인하는 것을 막는 경계입니다.

> **파일 권한(`--file-mode`)**: 기본 `private` 는 레인의 state/out/queue/lanes.d 디렉터리를 0700(소유자 전용)으로 잠가 다중 사용자 호스트에서 타 로컬 사용자의 대화·응답·설정 메타 열람을 차단합니다. `shared` 는 이 잠금을 하지 않는 옵트인(기존 umask 기본 권한 유지 — 통상 0755)으로, 열람 공유가 필요한 경우에만 사용하세요. (봇 토큰 `.env` 는 모드와 무관하게 항상 0600.)

## completion — 셸 자동완성

```bash
adde completion <bash|zsh>
```

명령·플래그 자동완성 스크립트를 stdout 으로 출력합니다(맥 기본 zsh + bash 지원). 명령/플래그 스펙에서 생성되므로 명령이 늘면 자동완성도 함께 갱신됩니다. 스크립트는 `adde` 와 짧은 별칭 `ad`·`add` 를 함께 등록합니다.

```bash
# zsh: compinit 후 fpath 에 두거나 .zshrc 에서 source
adde completion zsh > "${fpath[1]}/_adde"   # 또는: adde completion zsh >> ~/.zshrc 후 재로그인

# bash: bash-completion 디렉터리에 두거나 .bashrc 에서 source
adde completion bash > "$(brew --prefix)/etc/bash_completion.d/adde"
```

**완성 대상**:

- **최상위 명령 + 전역 플래그** — `up`/`down`/…/`lane`/`completion`, `-h`/`--help`/`-v`/`--version`. zsh 는 각 명령 옆에 짧은 설명을 표시합니다.
- **하위 명령·고정 값** — `lane add|ls|show|rm|help`, `completion bash|zsh`, `alias` 뒤 별칭 이름 제안, `status --all/--json`, `logs --engine`, `lane add` 옵션 플래그.
- **동적 프로젝트/레인 이름** — `${ADDE_HOME:-~/.config/adde}` 를 셸에서 직접 스캔합니다(`adde` 프로세스 미스폰): `up`/`down`/`restart`/`status`/`doctor`/`logs`/`sessions` 와 `lane ls|show|rm|add` 의 첫 위치에서 프로젝트 이름(예: `adde up <TAB>`, `adde status <TAB>`), 다음 위치에서 레인 이름(예: `adde logs <proj> <TAB>`, `adde lane show <proj> <TAB>`, `adde sessions <proj> <TAB>`).
- **enum 플래그 값** — `--source`(telegram|markdown), `--perm-tier`(acp|autopass), `--file-mode`(private|shared), `--lang`(en|ko) 뒤.
- **디렉터리 경로** — `--cwd`·`--root` 뒤.

미지원 셸은 오류 + 종료 코드 1.

## 도움말·오타 힌트

- `adde <command> --help`(또는 `-h`) — 해당 명령의 사용법을 출력하고 종료 코드 0. `adde lane <sub> --help` 는 lane 전체 옵션을 출력합니다.
- 오타 등 **미지원 명령**은 stderr 에 `Unknown command` + 근접 명령 추정(`Did you mean: …?`)을 출력하고 종료 코드 1(스크립트에서 오타가 조용히 성공 처리되는 것 방지).

## 종료 코드

| 명령         | 0                                | 1                                    |
| ------------ | -------------------------------- | ------------------------------------ |
| `up`         | 데몬 등록 성공                   | launchd 등록 실패·인자 누락          |
| `down`       | 데몬 종료 성공(이미 없어도 0)    | 오류 발생                            |
| `restart`    | down+up 모두 성공                | down 또는 up 실패                    |
| `status`     | 모두 정상                        | `dead`(크래시)·`stale`(행) 레인 존재 |
| `doctor`     | FAIL 없음                        | FAIL 항목 존재                       |
| `logs`       | 읽기 성공(파일 없어도 안내 후 0) | proj/lane 인자 누락·경로 검증 오류   |
| `init`       | 마법사 완료                      | 비TTY·인자 누락·검증/생성 오류       |
| `alias`      | 별칭 설치·이미 설정 확인         | `adde` PATH 미발견·설치 실패         |
| `lane *`     | 성공                             | 인자 누락·검증 오류                  |
| `completion` | 스크립트 출력                    | 셸 인자 누락·미지원 셸               |

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

**재부팅 자동복구**: `adde up` 으로 등록한 데몬은 macOS 재부팅·로그아웃 후에도 자동으로 재기동됩니다(`KeepAlive`/`RunAtLoad` 설정). 재부팅 후 `adde status <proj>` 로 복구를 직접 확인하는 것을 권장합니다.

**운영 검증 체크리스트**: 아래 항목은 자동 검증 범위 밖으로, 실 macOS 환경에서 직접 확인해야 합니다.

1. `adde up <proj>` → 터미널 종료 → 새 터미널에서 `adde status <proj>` 가 `running` 인지 확인
2. 다른 터미널에서 `adde down <proj>` 후 `adde status <proj>` 가 `stopped` 인지 확인
3. macOS 재부팅 후 `adde status <proj>` — 자동 복구 확인
4. `adde up <proj>` 연속 두 번 실행 — 이중 기동 없음 확인(경고 메시지 출력 후 스킵)
5. `adde down <proj>` 후 `ps aux | grep claude-code-acp` — orphan 프로세스 없음 확인
