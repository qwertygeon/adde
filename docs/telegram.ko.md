_[English](telegram.md) | 한국어_

# Telegram(미구현)

`telegram` 은 알려진 [서페이스](commands.ko.md#bind--채널-바인딩-관리)로 등록되어 `adde doctor` 와 채널 서페이스 목록에는 나타나지만, **본 릴리스에서는 stub** 입니다 — 봇 연동·long-poll·메시지 전달이 없습니다. `adde bind add <proj> <sid> --surface telegram ...` 시도는 거부됩니다.

- **Discord** 도 같은 상태입니다 — 등록만 되어 있고 stub, 기능 연동 없음.
- 현재 구현된 채널은 [마크다운 노트](markdown.ko.md) 뿐입니다.
- 채팅 앱으로 ADDE 를 구동하는 것은 추적 중인 후속 작업입니다(특정 릴리스에 무엇이 포함되는지는 공개 [Changelog](../CHANGELOG.md) 참조).

v0.2.x 의 Telegram 연동을 쓰고 있었다면: v0.2.x 설정·데이터는 v2 가 건드리지 않지만(물리적으로 분리된 설정 루트) v2 프로젝트/세션으로의 자동 이전 경로는 아직 없습니다 — [명령 레퍼런스 — v0.2.x 에서 이전](commands.ko.md#v02x-에서-이전) 참조.
