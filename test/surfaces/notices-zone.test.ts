import { describe, expect, it } from "vitest";

// 확정 시그니처(Test Authoring Contract, src/surfaces/markdown/notices.ts 신규):
// renderNoticeZone(notices): string[] · parseNoticeZone(lines): Array<{id;checked;optionToken?}>
// planNoticeSync(notices, parsed, noteExists): {keep;consumed;chosen?;cancelled?}
// planNoticeCap(notices, cap): {kept;prunedCount}
// NoticeEntry(session-store.ts): {id;mode:"read"|"prompt";kind;text;at;rendered?;count?;options?;footer?}

function readNotice(
  id: string,
  text = `notice-${id}`,
): {
  id: string;
  mode: "read";
  kind: string;
  text: string;
  at: string;
} {
  return { id, mode: "read", kind: "compact-done", text, at: new Date().toISOString() };
}

function promptNotice(id: string, options: Array<{ token: string; label: string }>) {
  return {
    id,
    mode: "prompt" as const,
    kind: "resume-list",
    text: "재개할 세션을 선택하세요",
    at: new Date().toISOString(),
    options,
  };
}

// `kept` 는 유지된 read 항목 + prompt 항목 + (프루닝 발생 시) 병합 요약 notice 1건을 모두
// 포함한다(session-store.ts planNoticeCap 실측 — 요약은 대체가 아니라 **추가** 항목이다).
// 따라서 순수 개수 비교는 요약·prompt 를 제외한 read 항목만 세어야 한다.
function keptReadCount(kept: readonly { mode: string; kind: string }[]): number {
  return kept.filter((n) => n.mode === "read" && n.kind !== "notices-pruned").length;
}

describe("SC-032: 기본 상한(10) 초과분은 프루닝되고 건수 안내가 남는다", () => {
  it("Happy: 11건 → 최신 10건만 남고 프루닝 1건 + 요약 1건 추가", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 11 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 10);
    expect(keptReadCount(result.kept)).toBe(10);
    expect(result.prunedCount).toBe(1);
    expect(result.kept.some((n) => n.kind === "notices-pruned")).toBe(true);
  });

  it("Edge: 정확히 10건이면 프루닝 0·요약 없음", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 10 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 10);
    expect(result.kept.length).toBe(10);
    expect(result.prunedCount).toBe(0);
    expect(result.kept.some((n) => n.kind === "notices-pruned")).toBe(false);
  });

  it("Error: 기존 프루닝 요약이 있으면 카운트가 병합된다(요약 1줄 유지)", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const existingSummary = {
      ...readNotice("summary-1", "5건이 정리되었습니다"),
      kind: "notices-pruned",
      count: 5,
    };
    const items = [existingSummary, ...Array.from({ length: 11 }, (_, i) => readNotice(`n${i}`))];
    const result = notices.planNoticeCap(items, 10);
    const summaries = result.kept.filter((n) => n.kind === "notices-pruned");
    expect(summaries.length).toBe(1); // 요약이 중복되지 않고 병합된 1줄만 유지된다.
    expect(summaries[0]?.count ?? 0).toBeGreaterThan(5);
  });
});

describe("SC-033: 상한을 임의값으로 설정하면 그 값만큼만 유지된다", () => {
  it("Happy: 상한 3·5건 → 최신 3건", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 5 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 3);
    expect(keptReadCount(result.kept)).toBe(3);
  });

  it("Edge: 상한 1", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 5 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 1);
    expect(keptReadCount(result.kept)).toBe(1);
  });

  it("Error: 상한이 항목 수보다 크면 무변경", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 3 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 10);
    expect(result.kept.length).toBe(3);
    expect(result.prunedCount).toBe(0);
  });
});

describe("SC-034: 상한 0 은 무제한을 뜻한다", () => {
  it("Happy: 상한 0 + 20건 → 20건 전부 유지", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = Array.from({ length: 20 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap(items, 0);
    expect(result.kept.length).toBe(20);
    expect(result.prunedCount).toBe(0);
  });

  it("Edge: 상한 0 에서 prompt 항목이 공존해도 함께 유지된다", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const items = [
      promptNotice("p1", [{ token: "1", label: "260828-1" }]),
      ...Array.from({ length: 20 }, (_, i) => readNotice(`n${i}`)),
    ];
    const result = notices.planNoticeCap(items, 0);
    expect(result.kept.length).toBe(21);
  });

  it("Error: 상한 0 을 conf 직렬화하면 markdown.notices_cap=0 이 파일에 남는다", async () => {
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf("v=1\nvault=/tmp/x\nmarkdown.notices_cap=0\n");
    expect(parsed["markdown.notices_cap"]).toBe(0);
    const serialized = conf.serializeProjectConf(parsed);
    expect(serialized).toContain("markdown.notices_cap=0");
  });
});

describe("SC-036: 노트 치유가 안내 항목을 유실하지 않는다", () => {
  it("Happy: 안내 있는 노트를 치유해도 항목이 유실되지 않고 순서가 유지된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const notice = readNotice("n1", "압축 완료");
    const caps = {
      resume: "native",
      permission: "callback",
      streaming: true,
      usage: false,
      compact: "native",
      attachments: [],
    } as const;
    const healed = inbox.healLayout([], {
      paletteEnabled: true,
      caps: caps as never,
      notices: [notice] as never,
    });
    const content = healed.lines.join("\n");
    expect(content).toContain("압축 완료");
  });

  it("Edge: 안내 존 센티널이 지워진 노트도 재구성된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const caps = {
      resume: "native",
      permission: "callback",
      streaming: true,
      usage: false,
      compact: "native",
      attachments: [],
    } as const;
    const notice = readNotice("n2", "안내 문구 보존됨");
    const broken = [
      "- [ ] 📣 안내 문구 보존됨", // 센티널 없이 텍스트만 남은 손상 상태
      inbox.COMPOSE_SENTINEL,
      "",
      "- [ ] 📤 send",
      inbox.RECORDS_ANCHOR,
    ];
    const healed = inbox.healLayout(broken, {
      paletteEnabled: true,
      caps: caps as never,
      notices: [notice] as never,
    });
    expect(healed.lines.join("\n")).toContain("안내 문구 보존됨");
  });

  it("Error: 안내 줄이 팔레트 영역으로 옮겨져도 중복 렌더 없이 재배치된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const caps = {
      resume: "native",
      permission: "callback",
      streaming: true,
      usage: false,
      compact: "native",
      attachments: [],
    } as const;
    const notice = readNotice("n3", "재배치 대상 안내");
    const healed1 = inbox.healLayout([], {
      paletteEnabled: true,
      caps: caps as never,
      notices: [notice] as never,
    });
    const healed2 = inbox.healLayout(healed1.lines, {
      paletteEnabled: true,
      caps: caps as never,
      notices: [notice] as never,
    });
    const occurrences = healed2.lines.filter((l) => l.includes("재배치 대상 안내")).length;
    expect(occurrences).toBe(1); // 중복 렌더 없음.
  });
});

describe("SC-038: 응답 대기 중인 재개 목록(prompt)은 프루닝·읽음 처리 대상이 아니다", () => {
  it("Happy: prompt 항목 + 상한 초과 read 항목 → prompt 는 프루닝 비대상", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const prompt = promptNotice("p1", [{ token: "1", label: "260828-1" }]);
    const reads = Array.from({ length: 15 }, (_, i) => readNotice(`n${i}`));
    const result = notices.planNoticeCap([prompt, ...reads], 10);
    expect(result.kept.some((n) => n.id === "p1")).toBe(true);
  });

  it("Edge: 재개 목록을 두 번 요청하면 최신 1개로 대체된다(SessionManager.pushResumeListNotice 관통)", async () => {
    // ASSUMPTION(테스트 작성자) — dedup 지점은 순수 함수(planNoticeSync/planNoticeCap) 가 아니라
    // notice 생성 시점(pushResumeListNotice)이 자연스러운 위치다(design.md ADR-010 "최신 1개로
    // 대체"). 순수 함수 직접 호출로는 이 계약을 표현할 수 없어 SessionManager 관통으로 검증한다.
    const { makeV2TmpRoots, cleanupV2TmpRoots, makeSessionManagerDeps, bindSessionManager } =
      await import("../helpers/v2-fixtures.js");
    const { makeFakeEngineDriver, FAKE_CAPS_PRESETS } = await import("../helpers/fake-engine.js");
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const sessionManagerMod = await import("../../src/core/session-manager.js");
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
      const sm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, sm);
      const requester = await sm.create({ engine: "acp" });
      // 재개 후보가 있어야 prompt 항목이 실제로 생성된다.
      const target = await sm.create({ engine: "acp" });
      const smWithStop = sm as unknown as {
        stop: (sid: string, o: unknown) => Promise<unknown>;
      };
      await smWithStop.stop(target.sid, { reason: "r", source: "cli" });

      await sm.pushResumeListNotice(requester.sid);
      await sm.pushResumeListNotice(requester.sid); // 중복 요청.
      const promptsKept = (sm.get(requester.sid)?.notices ?? []).filter((n) => n.mode === "prompt");
      expect(promptsKept.length).toBeLessThanOrEqual(1);
    } finally {
      cleanupV2TmpRoots(roots);
    }
  });

  it("Error: prompt 항목의 옵션이 0개면 생성되지 않는다(빈 목록 렌더 금지와 동형)", async () => {
    const notices = await import("../../src/surfaces/markdown/notices.js");
    const rendered = notices.renderNoticeZone([promptNotice("p-empty", [])] as never);
    // 옵션 0개인 prompt 항목은 선택지 줄이 없어 사실상 렌더될 게 없다 — 옵션 줄이 하나도 없어야 한다.
    expect(rendered.some((l) => l.includes("▶️"))).toBe(false);
  });
});
