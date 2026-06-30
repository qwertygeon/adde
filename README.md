# ADDE — Ai Driven Development Engine

> ⚠️ **상태: 초기 개발.** ACP 백엔드 + Telegram/마크다운 소스 어댑터 동작(PoC 수직 슬라이스). API 변동 가능.

ADDE 는 **AI CLI**(Claude Code / Codex 등)를 **채널**(Telegram / 마크다운 노트(예: Obsidian); Discord 보류)에서 원격 구동하는 게이트웨이입니다. AI 가 개발 작업을 수행하고, 사람은 채팅으로 지시·승인·관찰합니다.

## 사용자 문서

- [시작하기](docs/getting-started.md) — 설치·레인 설정·기동·상태/진단·프로젝트 폴더 매핑
- [Telegram 가이드](docs/telegram.md) — 봇 생성·토큰·기동 단계별
- [마크다운 가이드](docs/markdown.md) — 노트(예: Obsidian)로 AI 구동하기(지시·응답·권한 승인 단계별)
- [명령 레퍼런스](docs/commands.md) · [트러블슈팅](docs/troubleshooting.md)

## 핵심 설계

- **ACP 우선**: 엔진을 헤드리스 [Agent Client Protocol](https://agentclientprotocol.com) 서브프로세스로 띄우고 ADDE 가 ACP 클라이언트로 구동합니다. 지시·응답·권한·로그·사용량이 단일 이벤트 스트림으로 처리됩니다(터미널 스크래핑 없음).
- **엔진 독립**: `claude-code-acp`·`codex-acp` 가 같은 프로토콜을 말하므로 단일 백엔드 어댑터가 여러 엔진을 구동합니다.
- **레인 격리**: `(source × backend × project)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **fail-closed 권한**: 모든 권한 요청을 채널 승인으로 라우팅하고, 타임아웃·오류 시 기본 deny.

## 명령

```
adde up <proj>               # 프로젝트의 모든 레인 기동
adde down <proj>             # 레인 종료
adde status <proj> [--json]  # 레인 상태(running/stale/dead/stopped)
adde doctor [<proj>]         # 환경·설정 정적 점검
adde logs <proj> <lane> [N] [--engine]  # 레인 transcript(또는 --engine 시 엔진 stderr) 최근 N줄
adde lane add <proj> <lane>  # 레인 conf 생성 (옵션: --source/--cwd/--chat-id/--root/--interactive …)
adde lane ls <proj>          # 레인 목록
adde lane show <proj> <lane> # 레인 conf 출력
adde lane rm <proj> <lane>   # 레인 conf 삭제
add  …                       # adde 단축 별칭
```

레인 설정 상세는 [시작하기](docs/getting-started.md#레인-설정), 전체 명령은 [명령 레퍼런스](docs/commands.md)를 참조하세요.

## 런타임

- TypeScript + Node.js LTS
- macOS 1차 타깃 (launchd 데몬으로 상주)

## 상태 / 로드맵

- [x] 설계 (ACP 우선 재설계 완료)
- [x] 개발환경 스캐폴드 (TypeScript · pnpm · CI)
- [x] PoC (ACP 스파이크 · 권한 라우팅)
- [~] MVP: `markdown | telegram → claude(ACP)` 수직 슬라이스 (소스 어댑터·레인별 프로젝트 폴더 매핑 동작)
- [ ] Codex 백엔드 · Discord(보류) · 비-ACP CLI 스크래핑(보류)

## 라이선스 / 보안

- 라이선스: [MIT](LICENSE)
- 보안 취약점 보고: [SECURITY.md](SECURITY.md)

---

<sub>전신 프로젝트: [cctg](https://github.com/) (Claude Code Tmux Gateway). ADDE 는 cctg 의 `claude --channels` 의존을 걷어내고 ACP 기반으로 재설계한 후속 제품입니다.</sub>
