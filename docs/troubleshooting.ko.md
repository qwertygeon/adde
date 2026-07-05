_[English](troubleshooting.md) | 한국어_

# 트러블슈팅

증상별 진단·조치입니다. 먼저 두 명령으로 대부분을 좁힐 수 있습니다:

- `adde doctor [<proj>]` — 환경·설정 정적 점검(기동 전에도 실행 가능).
- `adde status <proj>` — 레인이 running / dead / stopped 중 무엇인지.
- `adde logs <proj> <lane>` — 최근 세션 활동.

## 목차

- [설치 직후 문제(npm)](#설치-직후-문제npm)
- [기동이 안 됨](#기동이-안-됨)
- [레인이 dead 로 표시됨](#레인이-dead-로-표시됨)
- [레인이 stale(행)로 표시됨](#레인이-stale행로-표시됨)
- [재부팅 후 복구·orphan 정리](#재부팅-후-복구orphan-정리)
- [메시지를 보내도 응답이 없음](#메시지를-보내도-응답이-없음)
- [세션 제어(clear/resume) 후 실패 통지](#세션-제어clearresume-후-실패-통지)
- [권한 관련](#권한-관련)
- [Telegram 전용](#telegram-전용)
- [마크다운 전용](#마크다운-전용)

## 설치 직후 문제(npm)

`npm i -g adde-acp` 직후 레인 기동 전에 마주치는 문제들입니다.

| 증상                                    | 원인                                 | 조치                                                                                                                                                 |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adde: command not found`               | 전역 bin 이 PATH 에 없음             | `npm bin -g` 경로가 PATH 에 있는지 확인. 사용자 prefix 사용 시 `~/.local/bin`(또는 설정한 prefix) 를 PATH 에 추가                                    |
| `ad`/`add` 단축 별칭이 없음             | 단축 별칭은 기본 미설치(옵트인)      | `adde alias`(또는 `adde init`)로 설치. 이미 같은 이름 명령이 있으면 덮어쓰지 않고 건너뜁니다 — [명령 레퍼런스](commands.ko.md#alias--단축-별칭-설치) |
| 설치 시 `EACCES` 권한 오류              | root 소유 Node prefix                | `sudo` 대신 버전 매니저(nvm/fnm) 또는 사용자 prefix(`npm config set prefix ~/.local`) 사용 — [시작하기 설치 절](getting-started.ko.md#설치)          |
| `adde --version` 은 되는데 레인이 안 뜸 | Claude 미인증 / 엔진 핸드셰이크 실패 | 같은 사용자에서 Claude(Claude Code)가 인증·동작하는지 확인(`ANTHROPIC_API_KEY` 또는 로그인). `adde logs <proj> <lane> --engine` 로 엔진 stderr 확인  |
| 엔진 로그에 `env: node: No such file`   | launchd 최소 PATH 에 node 없음       | `node` 설치 위치가 PATH 에 있는 상태로 `adde restart <proj>`(plist PATH 재주입). 아래 "기동이 안 됨" 참조                                            |

## 기동이 안 됨

먼저 `adde doctor <proj>` 를 실행해 `FAIL`/`WARN` 을 확인하세요.

| 증상                                 | 원인                                                                                 | 조치                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor` 가 ACP 어댑터 바이너리 FAIL | 엔진 어댑터 미설치                                                                   | `pnpm install`(예: `@agentclientprotocol/claude-agent-acp` 설치) 후 재시도                                                                                                                                                            |
| Node 버전 FAIL                       | Node < 22                                                                            | Node 22 이상으로 업그레이드                                                                                                                                                                                                           |
| `lanes.d 에 conf 없음`               | 레인 미생성                                                                          | `adde lane add <proj> <lane> ...`(또는 `--interactive`·`adde init`)로 생성                                                                                                                                                            |
| 토큰 FAIL (telegram)                 | `.env` 에 토큰 없음                                                                  | [Telegram 가이드 4단계](telegram.ko.md#4-봇-토큰-저장)로 토큰 저장                                                                                                                                                                    |
| cwd FAIL/경고                        | 작업 폴더 없음                                                                       | 폴더를 만들거나 conf 의 `cwd` 수정                                                                                                                                                                                                    |
| `doctor` 가 파일 권한 WARN           | `.env` 가 0600 아님, 또는 `file_mode=private` 인데 state 디렉터리가 그룹/기타에 열림 | 조치 힌트대로 `chmod 600 .../.env`(또는 `chmod 700 state/<lane>`) 후 `adde restart <proj>`. `shared` 모드는 의도된 선택으로 경고하지 않음                                                                                             |
| `doctor` 가 launchd 등록 불일치 WARN | plist 존재 vs launchctl 등록 상태 불일치                                             | `adde down <proj>` 로 정리한 뒤 `adde up <proj>` 로 다시 등록                                                                                                                                                                         |
| `doctor` 가 데몬 진입 파일 WARN      | 빌드 없이 dev 로 데몬 시도                                                           | `pnpm build` 후 `node dist/cli/adde.js up <proj>` 또는 전역 설치(`npm i -g .`) — 아래 "데몬은 등록됐는데 레인이 안 뜸"과 동일 원인                                                                                                    |
| 핸드셰이크 무응답으로 기동 실패      | 엔진이 응답 없이 멈춤                                                                | 엔진 바이너리·헬스 확인 후 `adde up` 재시도(ADDE 는 30초 후 타임아웃하고 child 를 정리). `adde logs <proj> <lane> --engine` 에 `env: node: No such file or directory` 가 보이면 PATH 문제 — 아래 "데몬으로 레인이 안 뜸" 참조         |
| 데몬은 등록됐는데 레인이 안 뜸       | 빌드 없이 `pnpm run dev up` 로 데몬 기동                                             | 데몬 워커는 launchd 가 띄우는 분리 프로세스라 tsx(dev)로는 안 됩니다. `pnpm build` 후 `node dist/cli/adde.js up <proj>` 또는 전역 설치(`npm i -g .`) 후 `adde up <proj>` 로 기동하세요(빌드본이 없으면 `adde up` 이 안내와 함께 거부) |

## 레인이 dead 로 표시됨

`adde status` 에서 `dead` 는 기동 프로세스가 비정상 종료(크래시)했는데 상태 파일이 남은 경우입니다.

```bash
adde down <proj>   # 잔존 상태 정리
adde doctor <proj> # 원인 점검
adde up <proj>     # 재기동
```

`adde logs <proj> <lane>` 로 종료 직전 활동을 확인하면 원인 파악에 도움이 됩니다.

## 레인이 stale(행)로 표시됨

`adde status` 의 `stale` 은 기동 프로세스(pid)는 살아있지만 하트비트(상태 파일 mtime)가 임계 시간 멈춘 경우입니다 — **행(hung) 의심**. 크래시(`dead`)와 달리 프로세스가 남아 있어 조치가 다릅니다.

```bash
adde logs <proj> <lane> --engine   # 엔진 stderr — 무엇에 막혔는지 확인
adde restart <proj>                # 데몬 재기동으로 회수
```

행의 흔한 원인은 엔진이 긴 작업/외부 대기에 묶였거나 응답이 멈춘 경우입니다. 재기동으로 풀리지 않으면 `--engine` 로그와 `adde doctor <proj>` 로 환경을 점검하세요.

## 재부팅 후 복구·orphan 정리

- **재부팅·로그아웃 후 레인이 안 떠 있음**: `adde up` 으로 등록된 데몬은 `KeepAlive`/`RunAtLoad` 로 자동 복구되지만, 실제 상태는 직접 확인하세요 — `adde status <proj>` 가 `running` 이 아니면 `adde doctor <proj>`(등록 상태 포함) 점검 후 `adde up <proj>` 재기동. plist 는 `adde up` 시점의 PATH 를 담으므로, 그 뒤 node/claude 설치 위치를 옮겼다면 `adde restart <proj>` 로 PATH 를 갱신하세요.
- **orphan 엔진 프로세스**: 비정상 종료 후 `claude-agent-acp` 엔진 프로세스가 남을 수 있습니다. `adde down <proj>` 후 `ps aux | grep claude-agent-acp` 로 잔존을 확인하고, 남아 있으면 해당 pid 를 종료하세요.

## 메시지를 보내도 응답이 없음

1. `adde status <proj>` 가 해당 레인을 `running` 으로 보이는지 확인합니다(아니면 위 항목으로).
2. `adde logs <proj> <lane>` 로 메시지가 수신·처리되는지 봅니다.
3. AI 턴이 길면 응답은 **턴 종료 시 한 번에** 옵니다(진행 중 스트리밍 없음). 잠시 기다려 보세요.
4. 디스크가 가득 차거나 권한 문제로 메시지 큐 적재가 연속 실패하면, ADDE 가 운영자 채널로 "enqueue 연속 N회 실패" 알림을 보냅니다 — 디스크 용량·`state` 디렉터리 권한을 확인하세요.

## 세션 제어(clear/resume) 후 실패 통지

채널에서 `/clear` 또는 `/resume` 은 엔진을 새 세션으로 **재기동**합니다. 재기동이 실패하면(엔진 스폰 오류·핸드셰이크 무응답 등) 채널로 `🛑 세션 제어 실패 — 엔진 재기동 오류` 통지가 오고, 해당 레인의 엔진이 내려간 채로 남을 수 있습니다.

- 조치: `adde restart <proj>` 로 데몬을 재기동해 레인을 복구하세요.
- 이후 `adde doctor <proj>`(엔진 어댑터·환경 점검)·`adde logs <proj> <lane> --engine`(엔진 stderr)으로 재기동 실패 원인을 확인합니다.
- `/compact` 는 재기동 없이 진행 중 세션에 압축 명령을 위임하므로 이 경로에 해당하지 않습니다.

## 권한 관련

> 권한 모델·티어·denylist·hard-deny 의 개념 설명은 [권한 가이드](permissions.ko.md)에 있습니다. 아래는 증상별 조치입니다.

- **항상 거부됨**: 권한 요청에 제때(기본 10분) 응답하지 않으면 fail-closed 로 자동 거부됩니다. 채널 도달 실패·오류도 거부로 처리됩니다. 특정 도구가 승인 프롬프트조차 없이 즉시 거부된다면 `hard_deny`(또는 `--safe-defaults` 위험 목록)에 걸린 것입니다 — conf 의 `hard_deny=` 를 확인하세요.
- **기동 시 권한 드리프트 경고**: 엔진의 실효 권한이 ADDE 정책보다 느슨하다고 확인되면(예: bypassPermissions) 콘솔·채널·transcript 에 경고를 표시하고 기동은 계속합니다. 이 상태에선 게이트가 무력화될 수 있으니 엔진 권한 설정을 해제하거나 conf 의 `perm_tier` 에 맞게 정렬하세요. 특히 `autopass` 레인은 엔진이 bypass 면 권한 요청 자체가 오지 않아 denylist 가 동작하지 않습니다.
- **승인이 너무 잦음**: 자주 쓰는 안전한 도구를 `--allowlist Read,Grep` 처럼 등록하면 매번 묻지 않습니다(게이트 자체는 유지, 트랜스크립트 기록). `Bash`·파일 쓰기 등 광범위 도구는 넣지 마세요(자기승인 위험). 대부분을 자동 허용하고 싶으면 옵트인 `--perm-tier autopass --denylist Bash,Write`(denylist 만 확인) 를 검토하세요 — [명령 레퍼런스](commands.ko.md#lane-add-옵션) 참고.

## Telegram 전용

| 증상                         | 확인                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 응답이 안 옴                 | conf 에 `chat_id` 가 설정됐는지(미지정 시 렌더 생략)                                                                                                                            |
| 보내도 무시됨(로그에 미허가) | 발신자가 허용 목록 밖. `chat_id`(자기 chat 자동 허용) 또는 `allow_from` 에 발신자 user/chat id 추가. 미설정이면 전부 거부(fail-closed) — 엔진 로그에 `unauthorized sender` 표시 |
| 토큰 형식 경고               | BotFather 발급 토큰이 `<숫자>:<영숫자>` 형식인지                                                                                                                                |
| 봇이 메시지를 못 받음        | 토큰이 올바른지, 봇이 차단되지 않았는지                                                                                                                                         |

상세 셋업: [Telegram 가이드](telegram.ko.md).

## 마크다운 전용

| 증상                          | 확인                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 체크해도 전송 안 됨           | `inbox` 경로 일치, send 박스 체크(`[x]`), 본문 비어있지 않은지                                                                         |
| 레인이 안 뜸                  | `root` 절대경로가 실제 존재하는지(없으면 fail-closed) · inbox/approvals/outbox 경로가 서로 겹치지 않는지(같거나 포함 관계면 기동 거부) |
| 기동이 거부됨(제어 노트 위치) | inbox·approvals·outbox 가 `cwd` **밖**에 있는지(안에 있으면 자기승인 위험으로 거부)                                                    |
| 응답 노트가 안 보임           | `outbox` 경로 확인, AI 턴이 끝났는지(idle)                                                                                             |

상세 셋업: [마크다운 가이드](markdown.ko.md).
