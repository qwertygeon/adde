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
- [sessions — 세션 목록](#sessions--세션-목록)
- [세션 제어 (채널 명령)](#세션-제어-채널-명령)
- [lane — 레인 설정](#lane--레인-설정)
- [종료 코드](#종료-코드)
- [경로](#경로)
- [macOS 전용 기능](#macos-전용-기능)

## 전역 옵션

| 옵션              | 설명        |
| ----------------- | ----------- |
| `-v`, `--version` | 버전 출력   |
| `-h`, `--help`    | 도움말 출력 |

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

- Telegram 은 메시지 전체가 명령과 **정확히 일치**할 때만 제어로 해석합니다 — 문장 속 `/clear` 는 일반 프롬프트로 전달됩니다.
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

### lane add 옵션

| 옵션                                                 | 기본값                                             | 설명                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--source <telegram\|markdown>`                      | `telegram`                                         | 채널 소스                                                                                                   |
| `--engine <name>`                                    | `claude-code-acp`                                  | ACP 엔진 프로필                                                                                             |
| `--backend <name>`                                   | `acp`                                              | 백엔드                                                                                                      |
| `--channel <name>`                                   | source 값                                          | 게이트 분기                                                                                                 |
| `--perm-tier <acp\|autopass>`                        | `acp`                                              | 권한 티어. `acp`=전 도구 채널 승인 / `autopass`=denylist 외 자동 허용(옵트인)                               |
| `--acp-version <v>`                                  | `v1`                                               | ACP 버전                                                                                                    |
| `--cwd <abs-path>`                                   | (supervisor cwd)                                   | 이 레인 AI 의 작업 폴더(프로젝트 매핑)                                                                      |
| `--allowlist <a,b,c>`                                | (없음)                                             | 자동 허용 도구(게이트는 유지, `perm_tier=acp` 용)                                                           |
| `--denylist <항목,...>`                              | autopass 시 내장 기본 목록(아래 **기본 denylist**) | `autopass` 에서 채널 승인으로 폴백할 도구·패턴 — `Bash`(도구 전체) 또는 `"Bash(git push*)"`(대표 인자 글롭) |
| `--lang <en\|ko>`                                    | (전역 로케일)                                      | 이 레인의 **채널 메시지** 언어(권한 프롬프트·경고 배너·알림 노트)                                           |
| `--chat-id <id>`                                     | (없음)                                             | telegram 회신 대상                                                                                          |
| `--token-stdin`                                      | —                                                  | telegram 봇 토큰을 stdin 에서 읽어 `.env`(0600) 기록                                                        |
| `--root <abs-path>`                                  | (없음)                                             | markdown 루트(예: Obsidian vault)                                                                           |
| `--inbox <rel>` `--approvals <rel>` `--outbox <rel>` | —                                                  | markdown 노트 경로(root 상대)                                                                               |
| `--force`                                            | —                                                  | 기존 conf 덮어쓰기                                                                                          |
| `--interactive`                                      | —                                                  | 대화형으로 필드 입력(TTY 전용, **토큰은 묻지 않음**)                                                        |

`--interactive` 는 대화형 터미널(TTY)에서만 동작합니다. 봇 토큰은 화면 노출을 피하기 위해 인터랙티브에서 받지 않으며, 생성 후 `--token-stdin` 또는 `.env` 직접 기록으로 설정합니다. 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상은 **경고**로 안내하되 생성은 진행됩니다.

> ⚠️ `--perm-tier autopass` 는 denylist 에 없는 **모든 도구(파일 쓰기·Bash 포함)를 채널 확인 없이 자동 허용**하는 옵트인 모드입니다. 확인이 필요한 도구는 `--denylist` 에 두세요. 자동 허용 내역은 transcript 에 기록되고, 기동 시 채널로 경고 배너가 전송됩니다. 기본값(`acp`)의 동작은 변하지 않습니다.
>
> allowlist/denylist 매칭은 엔진이 알려주는 원시 도구명(예: `Bash`, `Write`) 기준이며, 도구명을 확인할 수 없는 요청은 자동 허용하지 않고 채널 승인으로 보냅니다(fail-closed). 현재 도구명 제공은 `claude-code-acp` 엔진에서 확인되었습니다 — 도구명을 제공하지 않는 엔진에서는 autopass 여도 모든 요청이 채널 승인을 거칩니다(안전 방향).
>
> **denylist 패턴**: `Tool(글롭)` 형식으로 대표 인자를 매칭합니다 — Bash 는 명령 문자열, Read/Write/Edit 는 파일 경로, WebFetch 는 URL. `*` 는 임의 문자열(경로 구분자 포함)이고 전체 일치 기준이라 접두 차단은 `Bash(git push*)`, 포함 차단은 `Bash(*sudo *)` 처럼 씁니다. 인자를 확인할 수 없는 요청·패턴을 지원하지 않는 도구는 도구명만 맞아도 채널 승인으로 갑니다(과매칭=안전 방향). 도구명 비교는 대소문자를 무시합니다. **한계**: 매칭은 명령 문자열 전체 기준이라 셸 체이닝(`echo x && sudo y`)은 접두 패턴(`sudo *`)에 걸리지 않습니다 — 포함 패턴(`*sudo *`)을 추가하거나, 확실한 차단이 필요하면 도구 전체(`Bash`)를 지정하세요.
>
> **기본 denylist**: `--perm-tier autopass` 에서 `--denylist` 를 생략하면 파괴적 셸 명령과 자격증명 읽기를 승인으로 돌리는 내장 기본 목록을 conf 에 기록합니다 — `Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)`. 항목은 목록일 뿐 완전한 방어가 아닙니다(위 셸 체이닝 한계 참고) — 프로젝트에 맞게 조정하세요.

## 종료 코드

| 명령      | 0                             | 1                                    |
| --------- | ----------------------------- | ------------------------------------ |
| `up`      | 데몬 등록 성공                | launchd 등록 실패·인자 누락          |
| `down`    | 데몬 종료 성공(이미 없어도 0) | 오류 발생                            |
| `restart` | down+up 모두 성공             | down 또는 up 실패                    |
| `status`  | 모두 정상                     | `dead`(크래시)·`stale`(행) 레인 존재 |
| `doctor`  | FAIL 없음                     | FAIL 항목 존재                       |
| `logs`    | 항상(파일 없어도 안내 후 0)   | —                                    |
| `lane *`  | 성공                          | 인자 누락·검증 오류                  |

## 언어(로케일)

CLI 출력·채널 메시지는 en/ko 두 언어를 지원합니다.

- **결정 순서**: `ADDE_LANG`(명시) > `LC_ALL` > `LC_MESSAGES` > `LANG`(언어 코드 파싱, `ko*`→한국어) > 기본 **영어**. 한국어 macOS(`LANG=ko_KR.UTF-8`)에서는 별도 설정 없이 한국어로 출력됩니다.
- **레인별 채널 언어**: `adde lane add --lang <en|ko>`(또는 conf `lang=`) 로 그 레인의 채널 메시지(권한 프롬프트·경고 배너·알림 노트) 언어를 고정할 수 있습니다. 미지정 시 데몬 프로세스의 전역 로케일을 따릅니다.
- **주의(launchd 데몬)**: launchd 로 기동된 데몬은 셸의 `LANG` 을 상속하지 않을 수 있습니다 — 채널 메시지 언어를 확실히 하려면 레인 conf 에 `lang=` 을 지정하세요.

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
