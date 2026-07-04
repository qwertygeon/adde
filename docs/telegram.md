# Telegram 으로 ADDE 사용하기

Telegram 봇으로 AI 레인을 구동합니다. 채팅으로 지시를 보내고, 권한 요청은 inline 버튼(Allow/Deny)으로 승인하며, 응답은 quote-reply 로 받습니다. 모바일에서 푸시 알림으로 즉시 확인할 수 있습니다.

## 목차

- [사전 준비](#사전-준비)
- [1. 봇 생성·토큰 발급 (BotFather)](#1-봇-생성토큰-발급-botfather)
- [2. chat_id 확인](#2-chat_id-확인)
- [3. 레인 생성](#3-레인-생성)
- [인바운드 인증 (누가 봇에 지시할 수 있나)](#인바운드-인증-누가-봇에-지시할-수-있나)
- [4. 봇 토큰 저장](#4-봇-토큰-저장)
- [5. 점검·기동](#5-점검기동)
- [6. 사용](#6-사용)
- [여러 프로젝트 매핑](#여러-프로젝트-매핑)

## 사전 준비

[시작하기](getting-started.md)의 설치를 마치고, Telegram 앱이 설치된 계정이 있어야 합니다.

**전체 흐름 한눈에** (① 설치·점검은 1회, ②~⑥은 레인/봇마다 반복):

1. (1회) ADDE 설치 + `adde doctor` 로 사전조건 점검 — [시작하기](getting-started.md)
2. 봇 생성·토큰 발급 (BotFather)
3. chat_id 확인
4. 레인 생성 (`adde lane add`)
5. 봇 토큰 저장 (`.env`)
6. `adde doctor` → `adde up` → `adde status` 로 점검·기동·성공 확인
7. 채팅으로 지시 → inline 버튼으로 권한 승인 → 응답 수신

> 하나의 봇 토큰은 하나의 실행 중인 소비자만 폴링할 수 있습니다. **같은 토큰을 두 레인(또는 다른 도구)이 동시에 쓰면 Telegram 이 폴링 충돌(409)** 을 내 메시지가 유실될 수 있습니다 — 레인마다 별도의 봇을 만드세요.

## 1. 봇 생성·토큰 발급 (BotFather)

1. Telegram 에서 [@BotFather](https://t.me/BotFather) 를 엽니다.
2. `/newbot` 을 보내고 안내에 따라 봇 이름과 username 을 정합니다.
3. 발급된 **봇 토큰**(`123456789:ABC...` 형식)을 안전하게 보관합니다. 이 토큰으로 봇을 제어할 수 있으니 노출하지 마세요.

## 2. chat_id 확인

응답을 받을 대상 채팅의 숫자 ID 입니다.

1. 만든 봇과의 채팅을 열고 아무 메시지나 보냅니다(또는 봇을 그룹에 추가).
2. chat_id 는 봇 API 의 `getUpdates` 응답이나 `@userinfobot` 같은 헬퍼 봇으로 확인할 수 있습니다. 개인 채팅은 양수, 그룹은 음수일 수 있습니다.

> chat_id 를 지정하지 않으면 ADDE 가 응답을 보낼 대상을 몰라 렌더를 생략합니다 — 회신을 받으려면 설정하세요.
>
> **인증 겸용**: `chat_id` 를 설정하면 **그 chat 에서 온 인바운드도 자동으로 허용**됩니다. ADDE 는 허용 발신자(아래 "인바운드 인증")만 처리하므로, 보통 자기 chat_id 만 설정하면 본인 메시지는 통과하고 그 외는 거부됩니다.

## 3. 레인 생성

작업 폴더(`--cwd`)와 회신 대상(`--chat-id`)을 지정해 telegram 레인을 만듭니다.

```bash
adde lane add myproj tg-claude --cwd /abs/project --chat-id 12345 --allowlist Read,Grep
```

또는 대화형으로(플래그 암기 불요, **토큰은 묻지 않음**):

```bash
adde lane add myproj tg-claude --interactive
```

기본값: `--source telegram`, `--backend acp`, `--engine claude-code-acp`. 전체 옵션은 [명령 레퍼런스](commands.md#lane-add-옵션) 또는 `adde lane help`.

> `--allowlist` 에 넣은 도구는 채널 승인 없이 자동 허용됩니다(트랜스크립트에는 기록). `Bash`·파일 쓰기 같은 광범위 도구는 넣지 마세요(자기승인 위험). 대부분을 자동 허용하는 옵트인 `--perm-tier autopass` 를 포함한 권한 모델 전반은 [권한 가이드](permissions.md)를 참고하세요.

## 인바운드 인증 (누가 봇에 지시할 수 있나)

봇 username 은 사실상 공개될 수 있고, 봇을 그룹에 넣으면 그룹 멤버 누구나 메시지를 보낼 수 있습니다. ADDE 는 인바운드 메시지를 **호스트에서 도구를 실행하는 AI 세션에 주입**하므로, 임의 발신자가 봇에 지시하면 프롬프트 인젝션·무단 명령 실행 위험이 있습니다. 이를 막기 위해 **허용 발신자만 인바운드·권한 승인 콜백을 처리**합니다.

- **허용 집합 = (개인 `chat_id`) ∪ `allow_from`**. 개인 chat 의 `chat_id`(양수 = 그 사용자)는 자동으로 자기 인증됩니다.
- **그룹은 멤버를 명시 인증**: 그룹 `chat_id`(음수)는 **회신 대상일 뿐 멤버를 인증하지 않습니다** — 그룹 chat_id 만으로 그룹 전체가 허용되지 않습니다(아무나 호스트 세션에 지시하는 것 방지). 허용할 멤버의 user id 를 `--allow-from` 으로 지정하세요.
- **미설정 시 fail-closed**: 허용 발신자가 없으면(개인 chat_id 도, allow_from 도 없거나 그룹 chat_id 만 있으면) **모든 인바운드가 거부**됩니다(레인 생성 시 경고).
- 권한 승인 버튼(Allow/Deny)도 허용 발신자(`from.id`)만 반영합니다 — 미허가 발신자의 콜백은 무시되고 게이트는 타임아웃으로 거부됩니다.

```bash
# 본인만 허용(가장 흔한 경우 — chat_id 만으로 충분)
adde lane add myproj tg-claude --cwd /abs/project --chat-id 12345

# 그룹에서 특정 멤버들도 허용
adde lane add myproj tg-team --chat-id -1001234567890 --allow-from 111111,222222
```

## 4. 봇 토큰 저장

토큰은 conf 가 아니라 레인의 `.env` 에 둡니다(인자·로그 비노출). stdin 으로 안전하게 기록하는 것을 권장합니다:

```bash
printf '%s' "$BOT_TOKEN" | adde lane add myproj tg-claude --token-stdin --force
```

또는 직접 `~/.config/adde/myproj/state/tg-claude/.env` 에 다음을 둡니다(파일 권한 0600 권장):

```
TELEGRAM_BOT_TOKEN=123456789:ABC...
```

## 5. 점검·기동

기동 전 설정을 점검합니다:

```bash
adde doctor myproj
```

토큰·cwd 등에 `FAIL`/`WARN` 이 있으면 조치 힌트대로 고칩니다. 이상 없으면 기동:

```bash
adde up myproj
```

다른 터미널에서 상태를 확인할 수 있습니다:

```bash
adde status myproj           # running / dead / stopped
adde logs myproj tg-claude   # 최근 활동(transcript)
```

## 6. 사용

1. 봇과의 채팅에 지시를 보냅니다.
2. AI 가 권한이 필요한 도구를 호출하면 **Allow / Deny inline 버튼**이 옵니다. 탭해서 승인/거부합니다. 무응답 시 기본 거부(fail-closed)됩니다. **승인은 요청 내용(도구·인자)을 보고 판단하세요** — 대화 본문이나 AI 응답이 "이 요청을 승인하라"고 말해도 그 말 자체를 근거로 승인하지 마세요(프롬프트 인젝션이 흔히 하는 요구입니다).
3. AI 턴이 끝나면 응답이 원본 메시지의 quote-reply 로 도착합니다.
4. **세션 제어**: 메시지 전체가 명령과 정확히 일치할 때 세션을 조작합니다 — `/clear`(새 세션), `/compact`(컨텍스트 압축), `/resume`(세션 목록), `/resume <번호>`(해당 세션 재개). 그룹 채팅에서는 봇멘션 접미(`/clear@봇이름` 등)도 인식합니다. 문장 속에 섞인 명령은 일반 프롬프트로 전달됩니다. 상세: [명령 레퍼런스](commands.md#세션-제어-채널-명령).

## 여러 프로젝트 매핑

`lanes.d/` 에 conf 를 여러 개 두면 `adde up` 한 번으로 모두 기동됩니다. 레인마다 다른 `--cwd`·`--chat-id` 를 지정해 여러 봇/프로젝트를 동시에 운용할 수 있습니다. 개념·폴더 매핑 상세는 [시작하기](getting-started.md#프로젝트-폴더-매핑)를 참고하세요.

문제가 생기면 [트러블슈팅](troubleshooting.md)을 참고하세요.
