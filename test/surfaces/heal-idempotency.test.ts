import { describe, expect, it } from "vitest";

// `healLayout` 의 changed 판정은 "이 치유가 파일 바이트를 바꾸는가" 를 뜻한다. 호출자는 판정이
// false 면 쓰기를 건너뛰므로, 안정 상태 노트에 true 를 반환하면 내용이 같은 파일을 poll 마다
// 다시 쓴다(동기화 오염 + 읽기~쓰기 창의 사용자 편집 유실). 안정성은 반복 적용으로만 드러나므로
// 1회 적용 단언이 아니라 2회 이상 적용해 판정을 본다.

const CAPS = { compact: "native", resume: "native" } as const;

describe("healLayout 변경 판정의 안정성", () => {
  it("Happy: 안정 상태 노트를 두 번째로 치유하면 changed=false 이고 바이트가 변하지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const roundTrip = (content: string): { out: string; changed: boolean } => {
      const lines = content.length > 0 ? content.split("\n") : [];
      const healed = inbox.healLayout(lines, { paletteEnabled: true, caps: CAPS as never });
      return { out: healed.lines.join("\n") + "\n", changed: healed.changed };
    };

    // 1회차 — 빈 노트에서 정규 레이아웃을 만든다(여기선 changed=true 가 정상).
    const first = roundTrip("");
    expect(first.changed).toBe(true);

    // 2회차 — 이미 정규 레이아웃이므로 바꿀 것이 없다.
    const second = roundTrip(first.out);
    expect(second.out).toBe(first.out); // 바이트 불변
    expect(second.changed).toBe(false); // 따라서 쓰기 대상이 아니다

    // 3회차 — 반복해도 계속 안정(수렴 확인).
    const third = roundTrip(second.out);
    expect(third.out).toBe(first.out);
    expect(third.changed).toBe(false);
  });

  it("Happy: 실제 사용 형태(작성 중 초안 + 기록 존 마커)의 노트도 재치유에서 changed=false", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    // 실기기 vault 에서 관측된 형태 — 팔레트 4줄 · 초안 1줄 · send · 기록 존 마커 2줄.
    const content =
      [
        "- [ ] 🗄️ archive",
        "- [ ] 🧹 clear",
        "- [ ] 🗜️ compact",
        "- [ ] ♻️ resume",
        "<!-- adde:compose -->",
        "작성 중 초안",
        "- [ ] 📤 send",
        "<!-- adde:records -->",
        "- [x] ✅ sent [[0002 2026-08-26T22-57-24]]",
        "- [x] ✅ sent [[0001 2026-08-26T22-56-08]]",
      ].join("\n") + "\n";

    const healed = inbox.healLayout(content.split("\n"), {
      paletteEnabled: true,
      caps: CAPS as never,
    });
    expect(healed.lines.join("\n") + "\n").toBe(content); // 바꿀 것이 없다
    expect(healed.changed).toBe(false);
  });

  it("Happy: 실제로 고칠 것이 있으면 changed=true 를 유지한다(판정이 무조건 false 로 굳지 않음)", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    // 팔레트가 없는 노트 — 치유가 팔레트를 복원해야 하므로 변경이 실재한다.
    const broken = ["<!-- adde:compose -->", "초안", "- [ ] 📤 send", "<!-- adde:records -->"].join(
      "\n",
    );
    const healed = inbox.healLayout(broken.split("\n"), {
      paletteEnabled: true,
      caps: CAPS as never,
    });
    expect(healed.changed).toBe(true);
    expect(healed.lines.length).toBeGreaterThan(4);
  });
});
