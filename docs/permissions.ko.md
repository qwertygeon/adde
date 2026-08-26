_[English](permissions.md) | 한국어_

# 권한(게이트)

ADDE 는 AI 엔진의 **모든 권한 요청**(파일 쓰기, 셸 실행 등)을 **채널 승인으로 라우팅**합니다. 이 문서는 그 이유·티어 선택 방법·주의사항을 설명합니다. 설정은 **프로젝트 수준**입니다(그 프로젝트의 모든 세션이 공유) — 전체 플래그 레퍼런스: [명령 레퍼런스 — project add 옵션](commands.ko.md#project-add-옵션).

## 목차

- [왜 게이트가 필요한가](#왜-게이트가-필요한가)
- [권한 티어](#권한-티어)
- [allowlist / denylist](#allowlist--denylist)
- [hard-deny(즉시 거부)](#hard-deny즉시-거부)
- [매칭 규칙과 한계](#매칭-규칙과-한계)
- [권한 드리프트 경고](#권한-드리프트-경고)
- [권장 기본 설정](#권장-기본-설정)

## 왜 게이트가 필요한가

엔진은 헤드리스(ACP 서브프로세스)로 동작하므로 터미널 앞에서 프롬프트에 답할 사람이 없습니다. ADDE 는 승인 요청을 받아 **채널로 보냅니다**(현재는 마크다운 승인 노트; Telegram/Discord 인라인 승인은 아직 미구현) — 사람이 원격으로 허용/거부합니다.

- **fail-closed**: 기한(`gate_timeout_sec`, 기본 600초/10분) 내 무응답은 자동 **거부**됩니다. 채널 전달 실패나 다른 오류도 거부로 처리됩니다.
- 모든 결정(허용·거부·자동허용)은 대화 이벤트 기록에 남으므로, 그 결정을 유발한 턴 노트에서 감사할 수 있습니다.

## 권한 티어

프로젝트 생성 시 선택하거나 나중에 편집합니다 — 그 프로젝트의 모든 세션이 공유합니다(세션별 티어는 지원하지 않음 — 다른 정책이 필요하면 별도 프로젝트를 만드세요):

```bash
adde project add myproj --vault ~/Notes --perm-tier autopass --denylist "Bash,Write(/etc/*)"
adde project set myproj perm_tier acp
```

| 티어               | 자동 허용 대상            | 채널로 오는 것            | 위험도                                                                    |
| ------------------ | ------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `acp` **(기본)**   | `allowlist` 의 도구만     | **그 외 모든** 도구 요청  | 낮음 — 기본적으로 사람이 모든 것을 확인                                   |
| `autopass`(옵트인) | `denylist` **외** 모든 것 | `denylist` 의 도구/패턴만 | 높음 — 파일 쓰기·`Bash` 를 포함한 대부분 호출이 확인 없이 실행(전량 기록) |

`--denylist` 없이 `autopass` 를 선택하면 내장 기본 거부 목록을 시드하고(아래 참조) 생성 시 1회 안내를 출력합니다.

## allowlist / denylist

- **allowlist**(`--allowlist Read,Grep`, 또는 `adde project set <proj> allowlist Read,Grep`): `acp` 에서 매번 묻지 않을 도구. 게이트 자체는 켜져 있고 자동 허용 항목도 기록됩니다. `Bash` 나 파일 쓰기 같은 광범위한 도구는 넣지 마세요(자기승인 위험).
- **denylist**(`--denylist "Bash,Write,Bash(git push*)"`): `autopass` 에서 자동 허용에서 제외해 채널 승인으로 되돌릴 도구/패턴. `autopass` 에서 `--denylist` 를 생략하면 파괴적 명령과 자격증명 읽기를 막는 내장 기본 목록이 기록됩니다:

  `Bash(sudo *)` · `Bash(doas *)` · `Bash(rm -rf /*)` · `Bash(rm -rf ~*)` · `Bash(rm -rf .*)` · `Bash(git push --force*)` · `Bash(git push -f*)` · `Bash(git reset --hard*)` · `Bash(git clean -fd*)` · `Read(~/.ssh/**)` · `Read(~/.aws/**)` · `Read(~/.npmrc)` · `Read(~/.config/gh/hosts.yml)` · `Read(~/.kube/config)` · `Read(~/.docker/config.json)` · `Read(~/.config/gcloud/**)`

두 목록 모두 전체를 다시 입력하지 않고 증분 편집할 수 있습니다: `adde project set <proj> --add-allow Read,Grep`, `--rm-deny "Bash(git push*)"`([명령 레퍼런스](commands.ko.md#project-set--설정-편집) 참조).

## hard-deny(즉시 거부)

**hard-deny**(`--hard-deny "Bash(sudo *),Bash(rm -rf /*)"`, 키 `hard_deny`)는 `denylist` 와 같은 `Tool`/`Tool(glob)` 형식을 쓰지만 강도가 다른 방어심화 즉시-거부 목록입니다:

- **denylist("다시 물어보기")**: `autopass` 에서 자동 허용을 제외하고 **채널 승인으로 되돌립니다** — 사람이 승인하면 실행됩니다.
- **hard-deny("즉시 거부")**: `perm_tier`(기본 `acp` 포함)와 무관하게 **채널 프롬프트 없이 즉시 거부**합니다. 기본 `acp` 에서도 적용되므로 치명적 명령이 실수로 승인되는 것을 원천 차단합니다.

`project add` 의 `--safe-defaults` 는 위 기본 거부 목록과 동일한 내장 위험 목록으로 hard-deny 를 채웁니다(명시 `--hard-deny` 와 합집합). hard-deny 히트는 이벤트 기록에 남고 채널에 표면화됩니다.

## 매칭 규칙과 한계

- 매칭 키는 엔진이 보고하는 **원본 도구명**(예: `Bash`, `Write`)이며 대소문자 무시입니다. 도구명을 알 수 없는 요청은 자동 허용되지 않고 채널 승인으로 갑니다(fail-closed).
- **패턴** `Tool(glob)` 은 대표 인자와 매칭됩니다 — Bash = 명령 문자열, Read/Write/Edit = 파일 경로, WebFetch = URL. `*` 는 경로 구분자를 포함한 임의 문자열과 전체 매칭됩니다.
- **셸 체이닝**: Bash 의 경우 연쇄/그룹화된 각 하위 명령(`;` `&&` `||` `|` `&` 로 분리, 그룹화, `$(…)`, 백틱, 선행 `VAR=` 제거)도 매칭되므로 접두 패턴(`sudo *`)이 `echo x && sudo y` 도 잡습니다. 완전한 셸 파서가 아니라 best-effort 입니다 — alias/`eval`/변수 확장을 해석하지 않고, `bash -c "sudo y"` 같은 래퍼 호출은 잡지 못합니다. 확실한 차단이 필요하면 도구 전체(`Bash`)를 거부하세요.
- **게이트는 엔진이 ACP `requestPermission` 으로 넘긴 것만 봅니다.** 하위 엔진이 ADDE 에 묻기 전에 자체 설정으로 도구를 자동 승인하면 ADDE 의 게이트(hard_deny 포함)는 아예 관여하지 않습니다 — 이 경우 엔진 자체의 권한 설정을 직접 조정하세요.

## 권한 드리프트 경고

엔진의 실효 권한이 ADDE 정책보다 느슨한 것으로 확인되면(예: 엔진이 자체 권한 검사를 우회) ADDE 는 콘솔·채널·이벤트 기록에 경고하고 기동은 계속되지만 — 이 상태에서는 게이트가 무력화될 수 있습니다. 특히 엔진이 우회하는 `autopass` 프로젝트는 권한 요청 자체가 오지 않으므로 denylist 가 아무 효과가 없습니다.

## 권장 기본 설정

- 기본 `acp` 티어를 유지하고 자주 쓰는 **안전한 읽기형 도구만 `allowlist`** 에 넣으세요(예: `Read,Grep`).
- 대부분을 자동 허용해야 한다면 **옵트인**으로 `autopass` 를 쓰되, 되돌리기 어려운 도구(`Bash`, 파일 쓰기, 자격증명 읽기)는 `denylist` 로 확인을 유지하세요.
- `hard_deny`/`--safe-defaults` 로 치명적 명령을 티어와 무관하게 즉시 거부하도록 잠그세요 — 실수 승인의 여지를 없앱니다.
- 게이트를 프롬프트-응답 모드로 우회하려 하지 말고 `denylist`/`allowlist`/`hard_deny` 로 조여가세요.
