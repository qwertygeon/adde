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
- `adde up` 그레이스풀 셧다운 — SIGINT/SIGTERM 수신 시 레인을 정리(엔진 종료 포함)한 뒤 종료.
- 차단·예외 시 "상황 + 조치" 액션형 알림 — 무엇이 일어났고 어떻게 조치할지를 항상 함께 고지.
- 운영 가시성 명령 `adde status` · `doctor` · `logs` — 레인 상태(`running`/`dead`/`stopped`) 조회, 환경·설정 정적 점검(조치 힌트 포함), 레인 transcript 최근 N줄. `adde up` 이 기동 시 레인 라이브니스 상태 파일(`state/<lane>/runtime.json`)을 기록해 별도 프로세스인 `status` 가 교차 조회.
- 레인 하트비트 — `adde up` 이 주기적으로 상태 파일 mtime 을 갱신하고, `status` 가 `stale`(프로세스는 살아있으나 응답 없음 = 행/hung)을 정상(`running`)과 구분해 표면화(SEEN 컬럼·경고·비정상 종료코드).
- `adde logs <proj> <lane> --engine` — 엔진 서브프로세스 stderr 를 레인별 `engine.log` 로 캡처하고 조회(기본 transcript, `--engine` 시 엔진 출력).
- `adde lane add --interactive` — 대화형 레인 생성(TTY 전용, 봇 토큰은 화면 노출 회피 위해 비수집). 생성 시 `cwd` 부재·markdown `root` 부재·telegram 토큰 형식 이상을 경고로 안내(생성은 진행).
- 공개 문서 확장: `docs/telegram.md` · `docs/commands.md`(명령 레퍼런스) · `docs/troubleshooting.md`.
- 레포 메타: `LICENSE` · `SECURITY.md` · `CONTRIBUTING.md` · 이슈/PR 템플릿 · dependabot · `.editorconfig` + 테스트 커버리지 도구.

### Fixed

- 신뢰성 하드닝(P0): `adde down`/셧다운 시 ACP 엔진 자식 프로세스를 정리(SIGTERM→유예→SIGKILL)해 좀비 누수 차단. 엔진 핸드셰이크에 타임아웃을 둬 무응답 시 영구 대기 대신 기동 실패. 소스 정지(`stop`)를 비동기화해 진행 중 작업·롱폴 정리 후 종료(임시 리소스 정리 뒤 오류 방지). ACP 세션 이벤트 구독자 오류를 무음 흡수하지 않고 기록.
- 권한 설정 차이가 _확인되면_(엔진이 정책보다 느슨) 기동을 fail-closed 로 거부. 단 엔진이 실효 설정 조회를 미지원하는 경우는 경고 후 계속(요청별 권한 게이트가 계속 강제).

- `adde up` 이 레인 기동 후 메시지를 처리·응답하지 못하던 문제 — 수신 트리거(소스 enqueue→injector in-process 통지)·turn 연쇄·엔진 응답 캡처(`agent_message_chunk` 누적→`out/`→채널 렌더)를 배선. 내부 핸드오프는 fs.watch 대신 in-process 콜백(외부 inbox 감지만 watch 유지).
- `adde up` CLI 가 supervisor 기동 전 즉시 종료되던 문제 — 진입 로직 비동기화 및 포그라운드 상주.
- ACP 권한 핸들러를 `launch` 이전에 등록해 실패하던 순서 오류, 어댑터 바이너리 경로 오해석(`dist/index.js`), 엔진 spawn 오류 미처리 프로세스 크래시 수정.

- 마크다운 어댑터 크래시 시 중복 전송 — send 처리에 2단계 내구 마킹(`sending`→`sent`) + 존재검사 재개로 정확히 1회 보장.
- 마크다운 전송 트리거 오발동 — 트리거를 체크박스 라벨이 정확히 `send` 인 경우로 한정(메시지 본문의 'send' 포함 줄·사용자 todo 체크박스 오인 방지).
- allowlist 가 승인 경로에 미배선이던 문제 — 도구명이 allowlist 에 있으면 자동 allow 로 결정(채널 프롬프트 생략, 트랜스크립트 기록).

- 안전 표면: `out/` 출력과 사이드카(`.out.json`) 쓰기 순서 정리로 부분 기록 노출 차단, `claimNext` 의 파일 부재(정상)와 실제 오류를 구분(오류는 전파·로그), Telegram enqueue 연속 실패 감지·알림·백오프.
- 마크다운 `fs.watch` 누락 이벤트 보정 — 2초 주기 mtime+size 폴링 백스톱(감시 이벤트가 유실돼도 변경을 포착).
- 마크다운 부분 동기 읽기 방지 — 파일 내용이 안정될 때까지 재확인 후 처리(쓰는 도중 읽어 깨진 입력 방지).
- Telegram 4096자 초과 응답 청킹 — 줄 경계 우선으로 분할해 순차 전송(첫 청크만 원문 인용).
- Telegram 회복탄력성 — 429 응답의 `retry_after` 만큼 대기 후 재시도(횟수·상한 제한), 폴링 연속 실패 시 지수 백오프.
- 승인 요청당 파일 분리(`approvals/<req-id>.md`) — 동시 다중 승인 요청의 단일 파일 편집 충돌면 축소.
- 신뢰성: inject 실패 메시지를 `.failed` 로 보존(유실 방지), transcript 감사 기록 오류를 무음 흡수 대신 승격, injector 의 claim 을 직렬화해 동일 메시지 중복 처리 차단.
- 테스트 안정화 — 폴링 헬퍼를 실시간 타이머 + 시한초과 throw 로 전환해 부하 시 위양성(silent timeout) 제거.

- 전송 신뢰성 — 채널 전송 성공을 별도 마커(`out/<id>.sent`)로 분리. 응답 기록 후 채널 전송(render)이 실패하면 응답이 `out/` 에 보존되고 다음 처리 사이클·재기동에서 재전송(미전달 영구 손실 차단). telegram 멀티청크 응답의 부분 전송 실패도 재전송 경로로 흡수(at-least-once — 부분 전송 후 앞 청크 중복 가능).
- 큐 신뢰성 — 손상(파싱 불가) 큐 메시지를 격리(`processing/<id>.msg.corrupt` + `out/<id>.failed`)하고 다음 메시지로 진행(매 기동 동일 파싱 오류 반복 차단). `claimNext` 가 경합·손상 메시지를 건너뛰고 다음 유효 메시지를 claim.
- 권한 게이트 — 결정 대기자(pendingDecisions)를 타임아웃 포함 모든 종결 경로에서 정리(장기 상주 시 누수 차단).
- Telegram 입력 검증 — 콜백 decision 값이 allow/deny 가 아니면 무시·로그(fail-closed), 비숫자 `channel_msg_id` 의 `reply_to_message_id` 생략.
- 사용자 편의 — `adde up` 이 레인 기동 실패 시 어떤 레인이 왜 실패했는지 + 조치(`doctor`/`logs`)를 함께 표면화하고, 기동할 레인이 없으면 `adde lane add` 를 안내. `docs/getting-started.md` 에 설치 후 `adde doctor` 프리플라이트 안내 추가.
- 마크다운 enqueue 연속 실패 알림 — 임계 도달 시 outbox 노트(`_enqueue-alert.md`)로 1회 운영자 알림(telegram 패턴과 일관), 성공 시 리셋.

### Security

- 권한 요청 detail 마스킹 — 권한 요청 상세(toolCall)가 채널(텔레그램 메시지·마크다운 승인 노트)에 표면화되기 전 시크릿 마스킹 적용.

- 마크다운 자기승인 경계 — 제어 노트(inbox·approvals·outbox)가 AI 작업폴더(`cwd`) 내부면 fail-closed 로 레인 기동 거부(AI 의 승인/지시 노트 위조 차단).
- 입력 검증·노출 표면 강화 — envelope 텍스트 길이/형식·`channel_msg_id`·첨부 필드 검증, 마크다운 노트 경로의 디렉터리 탈출(`..`·절대경로) 차단, allowlist 항목 문자셋 제한, 로그·전사 시크릿 마스킹 패턴 확대(API 키·Bearer·`KEY=값`).

### Decided

- 구현 언어: TypeScript + Node.js LTS.
- 엔진 통합: ACP(Agent Client Protocol) 우선, protocolVersion 1.
