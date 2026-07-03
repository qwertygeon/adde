# Telegram 으로 ADDE 사용하기

Telegram 봇으로 AI 레인을 구동합니다. 채팅으로 지시를 보내고, 권한 요청은 inline 버튼(Allow/Deny)으로 승인하며, 응답은 quote-reply 로 받습니다. 모바일에서 푸시 알림으로 즉시 확인할 수 있습니다.

## 목차

- [사전 준비](#사전-준비)
- [1. 봇 생성·토큰 발급 (BotFather)](#1-봇-생성토큰-발급-botfather)
- [2. chat_id 확인](#2-chat_id-확인)
- [3. 레인 생성](#3-레인-생성)
- [4. 봇 토큰 저장](#4-봇-토큰-저장)
- [5. 점검·기동](#5-점검기동)
- [6. 사용](#6-사용)
- [여러 프로젝트 매핑](#여러-프로젝트-매핑)

## 사전 준비

[시작하기](getting-started.md)의 설치를 마치고, Telegram 앱이 설치된 계정이 있어야 합니다.

## 1. 봇 생성·토큰 발급 (BotFather)

1. Telegram 에서 [@BotFather](https://t.me/BotFather) 를 엽니다.
2. `/newbot` 을 보내고 안내에 따라 봇 이름과 username 을 정합니다.
3. 발급된 **봇 토큰**(`123456789:ABC...` 형식)을 안전하게 보관합니다. 이 토큰으로 봇을 제어할 수 있으니 노출하지 마세요.

## 2. chat_id 확인

응답을 받을 대상 채팅의 숫자 ID 입니다.

1. 만든 봇과의 채팅을 열고 아무 메시지나 보냅니다(또는 봇을 그룹에 추가).
2. chat_id 는 봇 API 의 `getUpdates` 응답이나 `@userinfobot` 같은 헬퍼 봇으로 확인할 수 있습니다. 개인 채팅은 양수, 그룹은 음수일 수 있습니다.

> chat_id 를 지정하지 않으면 ADDE 가 응답을 보낼 대상을 몰라 렌더를 생략합니다 — 회신을 받으려면 설정하세요.

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

> `--allowlist` 에 넣은 도구는 채널 승인 없이 자동 허용됩니다(트랜스크립트에는 기록). `Bash`·파일 쓰기 같은 광범위 도구는 넣지 마세요.

> ⚠️ 반대로 대부분을 자동 허용하고 지정한 도구만 물어보게 하려면 `--perm-tier autopass` 로 만듭니다(옵트인). denylist 도구·패턴(예: `"Bash(sudo *)"` — 생략 시 내장 기본 목록: 파괴적 명령·자격증명 읽기 차단)만 Allow/Deny 버튼이 오고 나머지는 자동 허용됩니다(전량 트랜스크립트 기록, 기동 시 채널 경고 배너). 상세: [명령 레퍼런스](commands.md#lane-add-옵션).

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
2. AI 가 권한이 필요한 도구를 호출하면 **Allow / Deny inline 버튼**이 옵니다. 탭해서 승인/거부합니다. 무응답 시 기본 거부(fail-closed)됩니다.
3. AI 턴이 끝나면 응답이 원본 메시지의 quote-reply 로 도착합니다.

## 여러 프로젝트 매핑

`lanes.d/` 에 conf 를 여러 개 두면 `adde up` 한 번으로 모두 기동됩니다. 레인마다 다른 `--cwd`·`--chat-id` 를 지정해 여러 봇/프로젝트를 동시에 운용할 수 있습니다. 개념·폴더 매핑 상세는 [시작하기](getting-started.md#프로젝트-폴더-매핑)를 참고하세요.

문제가 생기면 [트러블슈팅](troubleshooting.md)을 참고하세요.
