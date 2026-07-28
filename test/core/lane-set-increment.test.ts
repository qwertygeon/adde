import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { laneAdd, laneSet, LaneConfigError } from "../../src/core/lane-config.js";
import { DEFAULT_AUTOPASS_DENYLIST } from "../../src/shared/deny-match.js";
import { t } from "../../src/shared/i18n.js";

// I5 (v0.2.1/011) — lane set 목록 필드(allowlist/denylist/hard_deny) 증분 편집을 laneSet 코어에서
// 해소한다: 명시 목록 base 로 union/subtract, 전체 교체 충돌·add∩rm 모순 거부, 없는 rm 멱등+안내,
// denylist 빈 base + 유효 autopass 시 기본 denylist 시드(기본 보호 무결성, DEC-001).

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lane-inc-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("laneSet 목록 증분 — add 합집합", () => {
  it("allowlist add 가 현재 목록과 합집합되고 중복은 제거된다(순서 보존)", async () => {
    await laneAdd("proj", "l1", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read", "Write"],
    });
    const r = await laneSet("proj", "l1", { base, listAdd: { allowlist: ["Write", "Bash"] } });
    expect(r.conf.allowlist).toEqual(["Read", "Write", "Bash"]); // Write 중복 제거
  });
});

describe("laneSet 목록 증분 — rm 차집합", () => {
  it("allowlist rm 이 항목을 제거한다", async () => {
    await laneAdd("proj", "l2", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read", "Write", "Bash"],
    });
    const r = await laneSet("proj", "l2", { base, listRemove: { allowlist: ["Write"] } });
    expect(r.conf.allowlist).toEqual(["Read", "Bash"]);
  });

  it("없는 항목 rm 은 멱등 no-op 이고 warning 으로 안내된다(DEC-004)", async () => {
    await laneAdd("proj", "l3", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read"],
    });
    const r = await laneSet("proj", "l3", { base, listRemove: { allowlist: ["Nope"] } });
    expect(r.conf.allowlist).toEqual(["Read"]);
    expect(r.warnings.some((w) => w.includes("Nope"))).toBe(true);
  });
});

describe("laneSet 목록 증분 — add+rm 조합", () => {
  it("같은 명령에서 서로 다른 항목을 add·rm 한다", async () => {
    await laneAdd("proj", "l4", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read", "Write"],
    });
    const r = await laneSet("proj", "l4", {
      base,
      listAdd: { allowlist: ["Bash"] },
      listRemove: { allowlist: ["Write"] },
    });
    expect(r.conf.allowlist).toEqual(["Read", "Bash"]);
  });
});

describe("laneSet 목록 증분 — 충돌·모순 거부", () => {
  it("전체 교체(allowlist)와 증분(add)을 동시 지정하면 거부한다(DEC-002)", async () => {
    await laneAdd("proj", "l5", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read"],
    });
    await expect(
      laneSet("proj", "l5", { base, allowlist: ["X"], listAdd: { allowlist: ["Y"] } }),
    ).rejects.toBeInstanceOf(LaneConfigError);
  });

  it("같은 항목을 add 와 rm 에 동시 지정하면 거부한다(DEC-003)", async () => {
    await laneAdd("proj", "l6", {
      base,
      source: "markdown",
      perm_tier: "acp",
      allowlist: ["Read"],
    });
    await expect(
      laneSet("proj", "l6", {
        base,
        listAdd: { allowlist: ["Z"] },
        listRemove: { allowlist: ["Z"] },
      }),
    ).rejects.toBeInstanceOf(LaneConfigError);
  });
});

describe("laneSet 목록 증분 — hard_deny 병합은 '치환됨' 경고를 내지 않는다", () => {
  it("--add-hard-deny 는 기존 hard_deny 를 병합하고 replaced(치환) 경고를 내지 않는다", async () => {
    await laneAdd("proj", "l8", {
      base,
      source: "markdown",
      perm_tier: "acp",
      hard_deny: ["Bash(rm *)"],
    });
    const r = await laneSet("proj", "l8", { base, listAdd: { hard_deny: ["Bash(dd *)"] } });
    expect(r.conf.hard_deny).toEqual(["Bash(rm *)", "Bash(dd *)"]); // 병합(기존 보존)
    expect(r.warnings).not.toContain(t("laneConfig.warn.hardDenyReplaced")); // 치환 경고 없음
  });

  it("전체 교체 --hard-deny 는 기존 값이 있으면 치환 경고를 낸다(회귀 — 증분과 구분)", async () => {
    await laneAdd("proj", "l9", {
      base,
      source: "markdown",
      perm_tier: "acp",
      hard_deny: ["Bash(rm *)"],
    });
    const r = await laneSet("proj", "l9", { base, hard_deny: ["Bash(dd *)"] });
    expect(r.conf.hard_deny).toEqual(["Bash(dd *)"]); // 전체 치환
    expect(r.warnings).toContain(t("laneConfig.warn.hardDenyReplaced"));
  });
});

describe("laneSet 목록 증분 — denylist 기본 보호 무결성(DEC-001)", () => {
  it("빈 denylist 에서 같은 명령으로 autopass 전환 + denylist add 시 기본 denylist 를 시드해 보호를 유지한다", async () => {
    // acp 레인(denylist 명시 빈 값) → 같은 명령에서 autopass 전환 + denylist 증분.
    await laneAdd("proj", "l7", { base, source: "markdown", perm_tier: "acp" });
    const r = await laneSet("proj", "l7", {
      base,
      perm_tier: "autopass",
      listAdd: { denylist: ["Fetch"] },
    });
    for (const d of DEFAULT_AUTOPASS_DENYLIST) expect(r.conf.denylist).toContain(d);
    expect(r.conf.denylist).toContain("Fetch");
  });
});
