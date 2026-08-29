import { describe, expect, it } from "vitest";

// SC-035 (FR-014) — `markdown.notices_cap` 무효값(-1·abc)은 기본값(10)으로 폴백하며 무효값
// 경고를 남긴다(조용한 치환 금지). 정상값·미지정은 경고 0.

describe("SC-035: markdown.notices_cap 무효값은 경고와 함께 기본값으로 폴백한다", () => {
  it("Happy: 정상값(3) 로드 시 경고가 없다", async () => {
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf("v=1\nvault=/tmp/x\nmarkdown.notices_cap=3\n");
    expect(parsed["markdown.notices_cap"]).toBe(3);
    expect(parsed.warnings.some((w) => w.includes("notices_cap"))).toBe(false);
  });

  it("Edge: 값 미지정 시 기본값 10·경고 0", async () => {
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf("v=1\nvault=/tmp/x\n");
    expect(parsed["markdown.notices_cap"]).toBe(conf.DEFAULT_NOTICES_CAP);
    expect(parsed.warnings.some((w) => w.includes("notices_cap"))).toBe(false);
  });

  it("Error: -1·abc 는 기본값 폴백 + 무효값 경고 1건", async () => {
    const conf = await import("../../src/shared/conf.js");
    for (const raw of ["-1", "abc"]) {
      const parsed = conf.parseProjectConf(`v=1\nvault=/tmp/x\nmarkdown.notices_cap=${raw}\n`);
      expect(parsed["markdown.notices_cap"]).toBe(conf.DEFAULT_NOTICES_CAP);
      expect(parsed.warnings.some((w) => w.includes("notices_cap"))).toBe(true);
    }
  });
});
