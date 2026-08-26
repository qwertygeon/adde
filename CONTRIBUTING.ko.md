_[English](CONTRIBUTING.md) | 한국어_

# 기여 가이드

ADDE 에 기여해 주셔서 감사합니다. 이 문서는 개발 환경 구성부터 PR 까지의 흐름을 설명합니다.

## 목차

- [사전 준비](#사전-준비)
- [개발 환경 구성](#개발-환경-구성)
- [검증 (커밋 전 필수)](#검증-커밋-전-필수)
- [코드 스타일](#코드-스타일)
- [브랜치·PR 흐름](#브랜치pr-흐름)
- [이슈·보안](#이슈보안)

## 사전 준비

- Node.js >= 22
- [pnpm](https://pnpm.io) (저장소는 pnpm 을 사용합니다 — `packageManager` 핀 참조)

## 개발 환경 구성

```bash
pnpm install          # 의존성 설치
pnpm build            # 타입스크립트 빌드
pnpm dev <command>    # 로컬 실행(tsx, 예: pnpm dev --version)
```

## 검증 (커밋 전 필수)

게이트 전량을 한 명령으로 실행합니다 — CI 도 같은 스크립트를 그대로 돌리므로, 로컬에서 통과하면 CI 에서도 통과합니다:

```bash
pnpm gates
```

개별 게이트를 따로 돌릴 수도 있습니다:

```bash
pnpm typecheck        # 타입 검사
pnpm lint             # ESLint
pnpm format:check     # Prettier 포맷 확인 (수정: pnpm format)
pnpm i18n:check       # en/ko 카탈로그 패리티
pnpm usage:check      # 플래그 선언↔usage 문구 정합
pnpm build            # 타입스크립트 빌드 (테스트보다 먼저 — spawn 테스트가 dist/ 를 실행)
pnpm test             # vitest
```

`pre-push` 훅이 `pnpm gates` 를 실행해 게이트가 하나라도 실패하면 푸시를 막습니다. `pnpm install`
시점에 자동 활성화됩니다(`core.hooksPath` 를 `.githooks/` 로 지정). 의도적으로 넘기려면
`ADDE_SKIP_HOOKS=1 git push` 또는 `git push --no-verify` 를 씁니다.

커버리지 측정(선택):

```bash
pnpm test:coverage    # 커버리지 리포트 생성(coverage/)
```

## 코드 스타일

- 포맷은 Prettier, 린트는 ESLint 가 강제합니다. 에디터는 `.editorconfig` 를 따릅니다.
- TypeScript strict 모드. 기존 코드의 주석 밀도·네이밍·관용구에 맞춰 작성하세요.
- 사용자 노출 문자열은 `src/core/messages.ts`(CLI 카피)·`src/shared/notify.ts`(차단·예외 알림)에 모읍니다.

## 브랜치·PR 흐름

- 작업 브랜치: `feature/<주제>` 에서 시작합니다.
- PR 대상 브랜치는 **`develop`** 입니다(`main` 직접 PR 아님).
- PR 템플릿의 체크리스트를 채워주세요. 사용자 동작이 바뀌면 `docs/` 와 `CHANGELOG.md` 도 갱신합니다.
- 커밋 메시지는 변경 성격을 앞에 둡니다: `[feat]` / `[fix]` / `[docs]` / `[refactor]` 등.

## 이슈·보안

- 버그·기능 제안: GitHub 이슈 템플릿을 사용하세요.
- **보안 취약점은 공개 이슈로 열지 마세요** — [SECURITY.md](SECURITY.md) 의 비공개 보고 경로를 따르세요.
