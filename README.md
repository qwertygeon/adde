# ADDE — Ai Driven Development Engine

> ⚠️ **상태: 초기 개발.** 설계 + 개발환경 스캐폴드(TypeScript) 완료, 기능 구현 착수 전.

ADDE 는 tmux 위에서 도는 **AI CLI**(Claude Code / Codex 등)를 **채널**(Telegram / Obsidian; Discord 보류)에서 원격 구동하는 게이트웨이입니다. AI 가 개발 작업을 수행하고, 사람은 채팅으로 지시·승인·관찰합니다.

## 핵심 설계

- **ACP 우선**: 엔진을 헤드리스 [Agent Client Protocol](https://agentclientprotocol.com) 서브프로세스로 띄우고 ADDE 가 ACP 클라이언트로 구동합니다. 지시·응답·권한·로그·사용량이 단일 이벤트 스트림으로 처리됩니다(터미널 스크래핑 없음).
- **엔진 독립**: `claude-code-acp`·`codex-acp` 가 같은 프로토콜을 말하므로 단일 백엔드 어댑터가 여러 엔진을 구동합니다.
- **레인 격리**: `(source × backend × project)` 단위의 독립 수직 스택. 입력·승인·출력이 레인 안에서 완결됩니다.
- **fail-closed 권한**: 모든 권한 요청을 채널 승인으로 라우팅하고, 타임아웃·오류 시 기본 deny.

## 명령

```
adde   # 주 진입점 (슈퍼바이저·레인 제어)
add    # adde 단축 별칭
```

## 런타임

- TypeScript + Node.js LTS
- macOS 1차 타깃 (launchd 데몬으로 상주)

## 상태 / 로드맵

- [x] 설계 (ACP 우선 재설계 완료)
- [x] 개발환경 스캐폴드 (TypeScript · pnpm · CI)
- [~] PoC (ACP 스파이크 · 권한 라우팅)
- [ ] MVP: `obsidian | telegram → claude(ACP)` 수직 슬라이스
- [ ] Codex 백엔드 · Discord(보류) · 비-ACP CLI 스크래핑(보류)

## 라이선스 / 기여

추후 추가 예정.

---

<sub>전신 프로젝트: [cctg](https://github.com/) (Claude Code Tmux Gateway). ADDE 는 cctg 의 `claude --channels` 의존을 걷어내고 ACP 기반으로 재설계한 후속 제품입니다.</sub>
