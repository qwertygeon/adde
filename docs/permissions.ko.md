_[English](permissions.md) | 한국어_

# 권한 (게이트)

ADDE 는 AI 엔진의 모든 권한 요청(파일 쓰기·셸 실행 등)을 **채널 승인으로 라우팅**합니다. 이 문서는 왜 그런지, 티어를 어떻게 고르는지, 무엇을 조심할지를 설명합니다. 옵션·플래그의 전체 레퍼런스는 [명령 레퍼런스 — lane add 옵션](commands.ko.md#lane-add-옵션)이 기준입니다.

## 목차

- [왜 게이트인가](#왜-게이트인가)
- [권한 티어](#권한-티어)
- [allowlist / denylist](#allowlist--denylist)
- [hard-deny (즉시 거부)](#hard-deny-즉시-거부)
- [매칭 규칙과 한계](#매칭-규칙과-한계)
- [권한 드리프트 경고](#권한-드리프트-경고)
- [권장 베이스라인](#권장-베이스라인)

## 왜 게이트인가

엔진은 헤드리스(ACP 서브프로세스)로 돌기 때문에, 터미널 앞에서 프롬프트에 응답할 사람이 없습니다. ADDE 가 그 승인 요청을 대신 **채널(Telegram inline 버튼 / 마크다운 승인 노트)로 보내** 사람이 원격에서 허용/거부하게 합니다.

- **fail-closed**: 제때(기본 10분) 응답하지 않으면 자동 **거부**됩니다. 채널 도달 실패·오류도 거부로 처리됩니다 — "모르면 막는다".
- 모든 결정(허용·거부·자동 허용)은 transcript 에 기록됩니다.

## 권한 티어

레인마다 `perm_tier` 로 고릅니다(`adde lane add --perm-tier <acp|autopass>` 또는 conf `perm_tier=`).

| 티어                | 무엇이 자동 허용         | 무엇이 채널로 오는가         | 위험도                                                          |
| ------------------- | ------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `acp` **(기본)**    | `allowlist` 에 둔 도구만 | 그 외 **모든** 도구 요청     | 낮음 — 기본적으로 전부 사람이 확인                              |
| `autopass` (옵트인) | `denylist` **밖의** 전부 | `denylist` 에 든 도구·패턴만 | 높음 — 파일 쓰기·`Bash` 포함 대부분이 확인 없이 실행(전량 기록) |

- `autopass` 레인은 기동 시 채널로 **경고 배너**(자동 허용 모드·denylist 구성)를 보냅니다.
- 기본값(`acp`)의 동작은 어떤 경우에도 바뀌지 않습니다.

## allowlist / denylist

- **allowlist** (`--allowlist Read,Grep`): `acp` 티어에서 매번 묻지 않을 도구. 게이트 자체는 유지되고 자동 허용 내역은 기록됩니다. `Bash`·파일 쓰기 등 광범위 도구는 넣지 마세요(자기승인 위험).
- **denylist** (`--denylist "Bash,Write,Bash(git push*)"`): `autopass` 티어에서 자동 허용에서 빼고 채널 승인으로 되돌릴 도구·패턴. `--denylist` 를 생략하면 파괴적 명령·자격증명 읽기를 막는 내장 기본 목록이 conf 에 기록됩니다.

## hard-deny (즉시 거부)

**hard-deny** (`--hard-deny "Bash(sudo *),Bash(rm -rf /*)"`, conf 키 `hard_deny=`)는 방어심화용 즉시 거부 목록입니다. `--denylist` 와 같은 `Tool` / `Tool(글롭)` 형식을 쓰지만 강도가 다릅니다.

- **denylist("확인으로 되돌림")**: `autopass` 에서 자동 허용을 빼고 **채널 승인으로 폴백**합니다 — 사람이 승인하면 실행됩니다.
- **hard-deny("즉시 거부")**: 매칭 요청을 **`perm_tier` 와 무관하게 채널 프롬프트조차 없이 즉시 거부(취소)** 합니다. 기본 `acp` 티어에도 적용되므로, **파국적 명령이 실수로 승인되는 것 자체를 차단**합니다. hard-deny 적중은 transcript 에 기록되고 채널로 통지가 갑니다.

`--safe-defaults`(conf 키에는 반영, 대화형 `lane add`/`adde init` 이 활성화 여부를 물음, 기본 예)를 켜면 내장 위험 목록으로 hard-deny 를 채웁니다(명시한 `--hard-deny` 와 합집합):

`Bash(sudo *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`.

목록은 목록일 뿐 완전한 방어가 아닙니다(아래 셸 체이닝 참고) — 프로젝트에 맞게 조정하세요.

## 매칭 규칙과 한계

- 매칭 키는 엔진이 알려주는 **원시 도구명**(예: `Bash`, `Write`)이며 대소문자를 무시합니다. 도구명을 확인할 수 없는 요청은 자동 허용하지 않고 채널 승인으로 보냅니다(fail-closed).
- **패턴** `Tool(글롭)` 은 대표 인자를 매칭합니다 — Bash=명령 문자열, Read/Write/Edit=파일 경로, WebFetch=URL. `*` 는 임의 문자열(경로 구분자 포함), 전체 일치 기준입니다(접두 차단 `Bash(git push*)`, 포함 차단 `Bash(*sudo *)`).
- **셸 체이닝**: Bash 명령은 체이닝된 하위 명령을 개별 매칭합니다(`;` `&&` `||` `|` `&`·개행으로 분리, 선행 `VAR=` 대입 제거) — 접두 패턴(`sudo *`)이 `echo x && sudo y`·`FOO=1 sudo y` 를 잡습니다. 완전한 셸 파서가 아닌 best-effort 입니다(alias·`eval`·변수 확장은 해석하지 않음) — 확실한 차단은 도구 전체(`Bash`)를 지정하세요.

## 권한 드리프트 경고

엔진의 실효 권한이 ADDE 정책보다 느슨하다고 확인되면(예: 엔진이 `bypassPermissions`), 콘솔·채널·transcript 에 경고하고 기동은 계속합니다. 이 상태에선 게이트가 무력화될 수 있으니 엔진 권한 설정을 해제하거나 conf `perm_tier` 에 맞게 정렬하세요. 특히 **`autopass` 레인은 엔진이 bypass 면 권한 요청 자체가 오지 않아 denylist 가 동작하지 않습니다.**

## 권장 베이스라인

- 기본 `acp` 티어를 유지하고, 자주 쓰는 **안전한 읽기 계열 도구만 `--allowlist`**(예: `Read,Grep`)에 둡니다.
- 대부분을 자동 허용해야 한다면 `autopass` 를 **옵트인**하되, 되돌리기 어려운 도구(`Bash`·파일 쓰기·자격증명 읽기)는 반드시 `denylist` 로 확인을 유지하세요.
- 파국적 명령은 티어와 무관하게 `--hard-deny`(또는 `--safe-defaults`)로 아예 즉시 거부하도록 잠그세요 — 실수 승인 여지를 없앱니다.
- 프롬프트 응답 모드로 게이트를 우회하려 하지 말고, **denylist·allowlist·hard-deny 로 조이는 방향**을 택하세요.
