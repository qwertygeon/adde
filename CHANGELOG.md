# Changelog

이 프로젝트의 주목할 변경을 기록합니다. [Keep a Changelog](https://keepachangelog.com/) 형식, [SemVer](https://semver.org/) 준수.

## [Unreleased]

### Added

- 레포 메타: `README.md` · `VERSION`(0.1.0) · `CHANGELOG.md` · `.gitignore`.
- TypeScript 개발환경 스캐폴드: pnpm · `tsconfig`(strict) · ESLint/Prettier · vitest · CI/release 워크플로 · `src/` 골격.
- ACP 백엔드 + Telegram 소스 어댑터 + 직렬 인젝터 + fail-closed 권한 게이트(PoC 수직 슬라이스).
- 마크다운 소스 어댑터(예: Obsidian): 노트 파일 핸드셰이크(인박스 체크박스 송신 · 승인 노트 권한 · 출력 노트 · 동기 충돌 격리).
- 레인별 프로젝트 폴더 매핑(`cwd`) — 레인마다 다른 작업 폴더에서 엔진 기동.
- 레인 설정 서브커맨드 `adde lane add/ls/show/rm` — `.conf` 파일 생성·조회·삭제(검증 후 원자적 기록, telegram 토큰 stdin→`.env` 0600).
- conf `cwd`/`root` 경로의 선행 `~` 홈 디렉터리 확장.
- 사용자 문서: `docs/getting-started.md` · `docs/markdown.md` · `docs/README.md`.

### Fixed

- `adde up` 이 레인 기동 후 메시지를 처리·응답하지 못하던 문제 — 수신 트리거(소스 enqueue→injector in-process 통지)·turn 연쇄·엔진 응답 캡처(`agent_message_chunk` 누적→`out/`→채널 렌더)를 배선. 내부 핸드오프는 fs.watch 대신 in-process 콜백(외부 inbox 감지만 watch 유지).
- `adde up` CLI 가 supervisor 기동 전 즉시 종료되던 문제 — 진입 로직 비동기화 및 포그라운드 상주.
- ACP 권한 핸들러를 `launch` 이전에 등록해 실패하던 순서 오류, 어댑터 바이너리 경로 오해석(`dist/index.js`), 엔진 spawn 오류 미처리 프로세스 크래시 수정.

- 마크다운 어댑터 크래시 시 중복 전송 — send 처리에 2단계 내구 마킹(`sending`→`sent`) + 존재검사 재개로 정확히 1회 보장.
- 마크다운 전송 트리거 오발동 — 트리거를 체크박스 라벨이 정확히 `send` 인 경우로 한정(메시지 본문의 'send' 포함 줄·사용자 todo 체크박스 오인 방지).
- allowlist 가 승인 경로에 미배선이던 문제 — 도구명이 allowlist 에 있으면 자동 allow 로 결정(채널 프롬프트 생략, 트랜스크립트 기록).

### Security

- 마크다운 자기승인 경계 — 제어 노트(inbox·approvals·outbox)가 AI 작업폴더(`cwd`) 내부면 fail-closed 로 레인 기동 거부(AI 의 승인/지시 노트 위조 차단).

### Decided

- 구현 언어: TypeScript + Node.js LTS.
- 엔진 통합: ACP(Agent Client Protocol) 우선, protocolVersion 1.
