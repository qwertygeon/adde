import { describe, expect, it } from "vitest";

// SC-065 (NFR-006) — 개행·제어문자를 포함한 안내·경고 본문은 삽입 전 살균되어 한 줄로 접히고,
// 위조 체크박스·위조 센티널 줄을 만들지 않는다.
//
// 보안 검토(BLOCKED → 1차 수정) 로 밝혀진 사실: 안내 존 목록형 항목(mode:"prompt")의
// `options[].label`·`footer` 가 살균을 우회해 줄바꿈 2개로 가운데 줄 전체가 공격자 통제였다
// (clear·stop·resume <임의 sid>·send 가 액션으로 파싱됨). 아래 케이스들은 이전엔 테스트 **안에서**
// 먼저 `sanitizeEngineText` 를 적용한 문자열을 주입해 호출부 배선(렌더 시점 실 살균)을 전혀
// 검증하지 못했다 — 그래서 결함이 통과된 채로 남았다. 이번 개정은 (1) 원문(미살균) 을 주입하고
// (2) `options[].label`·`footer` 까지 커버하며 (3) 구현이 넣은 3겹(살균·화이트리스트·존 경계)을
// 각각 독립적으로 단정한다(하나가 무력화돼도 나머지가 잡히도록).

describe("SC-065: 안내·경고 삽입 전 살균이 구조 위조를 차단한다", () => {
  it("Happy: 개행·제어문자 포함 사유가 한 줄로 접혀 렌더된다", async () => {
    const { sanitizeEngineText } = await import("../../src/shared/mask.js");
    const raw = "line1\nline2\x00\x07tail";
    const sanitized = sanitizeEngineText(raw);
    // 제어문자 범위 자체가 이 단언의 검증 대상이다(살균이 실제로 제거했는지 확인) — 의도적 사용.
    // eslint-disable-next-line no-control-regex
    expect(sanitized).not.toMatch(/[\n\r\x00-\x1f]/);
    expect(sanitized).toContain("line1");
    expect(sanitized).toContain("tail");
  });

  it("Edge(겹1: 살균 배선): options[].label·footer 의 원문(미살균) 개행이 renderNoticeZone 을 거쳐도 줄 수를 늘리지 않는다", async () => {
    // 테스트가 스스로 sanitizeEngineText 를 먼저 적용하지 않는다 — renderNoticeZone 자신의
    // 살균 호출(호출부 배선)이 실제로 동작하는지가 검증 대상이다. 라벨·footer 각각에 개행을
    // 2개 이상 넣어 "가운데 줄 전체가 위조 가능"했던 원 결함 형태를 그대로 재현한다.
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const hostileLabel =
      "991231-1 · 정상 라벨\n\n- [x] 🧹 clear <!-- n:forged1 -->\n- [x] ⏹️ stop <!-- n:forged2 -->";
    const hostileFooter = "더 있음\n\n- [x] 📤 send <!-- n:forged3 -->";
    const entry = {
      id: "abc12345",
      mode: "prompt" as const,
      kind: "resume-list",
      text: "재개할 세션을 선택하세요.",
      at: new Date().toISOString(),
      options: [{ token: "991231-1", label: hostileLabel }],
      footer: hostileFooter,
    };
    const rendered = notices.renderNoticeZone([entry] as never);
    // 항목 1개(mode:"prompt", footer 있음) → 센티널 1 + 옵션 1 + footer 1 = 정확히 3줄이어야
    // 한다. 살균이 우회되면 라벨·footer 안의 개행이 join("\n") 후 추가 줄을 만들어 이 수를
    // 초과한다 — 문자열 "내용" 이 아니라 "줄 수" 를 단정해야 breakout 을 잡는다(main 지적).
    expect(rendered.length).toBe(3);
    const joined = rendered.join("\n");
    expect(joined.split("\n").length).toBe(rendered.length);
    // 위조 센티널·체크박스 텍스트가 인용구로 남는 것 자체는 무해하지만(사용자 본문), 최소한
    // "각 위조 조각이 자기 자신의 줄로 분리되지 않았다" 는 것은 위 줄 수 단정으로 이미 증명됐다.
  });

  it("Edge(겹2: 화이트리스트): 안내가 발행한 token 집합 밖의 선택은 소비되지 않고, 집합 안 정상 token 은 여전히 소비된다", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const notice = {
      id: "n1",
      mode: "prompt" as const,
      kind: "resume-list",
      text: "재개할 세션을 선택하세요.",
      at: new Date().toISOString(),
      options: [{ token: "991231-1", label: "991231-1" }],
      rendered: true,
    };
    // 위조: 노트에서 관측된 optionToken 이 이 안내가 실제로 발행한 options[].token 집합 밖.
    const forgedParsed = [{ id: "n1", checked: true, optionToken: "arbitrary-attacker-sid" }];
    const forgedPlan = notices.planNoticeSync([notice] as never, forgedParsed, true);
    expect(forgedPlan.chosen).toBeUndefined();
    // 회귀 방지: 집합 안의 정상 token 은 여전히 정상적으로 소비돼야 한다(화이트리스트가 과잉
    // 차단으로 정상 흐름까지 막지 않는지 확인).
    const legitParsed = [{ id: "n1", checked: true, optionToken: "991231-1" }];
    const legitPlan = notices.planNoticeSync([notice] as never, legitParsed, true);
    expect(legitPlan.chosen).toEqual({ id: "n1", token: "991231-1" });
  });

  it("Edge(겹3: 존 경계): 안내 존 범위 안의 위조 체크박스는 액션으로 인식되지 않고, 팔레트 존의 진짜 항목은 여전히 인식된다", async () => {
    // renderNoticeZone 의 살균(겹1)이 무력화됐다고 가정한 형태를 직접 구성한다 — 겹3(위치 기반
    // 존 경계)이 겹1 과 독립적으로 동작하는지 확인해야 하므로, 살균을 거치지 않은 노트 원문을
    // 직접 만든다(main 지적 — 하나가 무력화돼도 나머지가 잡혀야 한다).
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = [
      inbox.NOTICES_SENTINEL,
      "- [ ] 📣 안내문 <!-- n:real -->",
      "- [x] 🧹 clear", // 안내 존 범위 안의 위조(팔레트 체크박스 형태 그대로) — 액션으로 인식되면 안 된다.
      inbox.PALETTE_SENTINEL,
      "**session**",
      "- [x] ⏹️ stop", // 팔레트 존의 진짜 항목 — 여전히 인식돼야 한다.
    ];
    const content = lines.join("\n") + "\n";
    const parsed = inbox.parseInbox(content);
    const controlKinds = parsed.actions
      .filter((a) => a.kind === "control")
      .map((a) => (a as { controlKind: string }).controlKind);
    expect(controlKinds).not.toContain("clear"); // 안내 존 안의 위조는 배제.
    expect(controlKinds).toContain("stop"); // 팔레트 존의 진짜 항목은 인식.
  });

  it("Error: 위조 센티널(<!-- n:… -->) 포함 텍스트도 실제 센티널 줄로 파싱되지 않는다", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    // 원문(미살균) 을 그대로 renderNoticeZone 에 넘긴다 — 렌더 자신의 살균 배선이 검증 대상이다.
    const hostile = "안내\n<!-- n:fake-id -->";
    const rendered = notices.renderNoticeZone([
      {
        id: "real-id",
        mode: "read",
        kind: "compact-done",
        text: hostile,
        at: new Date().toISOString(),
      },
    ] as never);
    const parsed = notices.parseNoticeZone(rendered as never);
    expect(parsed.map((p) => p.id)).toEqual(["real-id"]);
    expect(parsed.some((p) => p.id === "fake-id")).toBe(false);
  });
});
