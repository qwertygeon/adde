import { describe, expect, it } from "vitest";
import type { UsageCatalog, UsageCheck, DriftIssue } from "../../scripts/check-usage-drift.js";

// N9 선언↔usage 정적 검사 (FR-008) — 양방향 합성 입력 단위 검증.

describe("선언 flag 가 usage 에 없으면 missing-in-usage 로 지목 (SC-011 Error)", () => {
  it("합성 선언에 --foo 를 추가하고 대상 usage 에 미반영하면 실패로 지목한다", async () => {
    const { usageDriftIssues } = await import("../../scripts/check-usage-drift.js");
    const catalog: UsageCatalog = {
      locale: "en",
      texts: { "usage.synthetic": "Usage: adde synthetic [options]" },
    };
    const checks: UsageCheck[] = [{ usageKey: "usage.synthetic", declaredFlags: ["--foo"] }];
    const issues: DriftIssue[] = usageDriftIssues(catalog, checks);
    expect(
      issues.some((i) => i.kind === "missing-in-usage" && i.flag === "--foo"),
      "--foo 가 missing-in-usage 로 지목되지 않음",
    ).toBe(true);
  });
});

describe("usage 의 flag 가 선언·전역에 없으면 undeclared 로 지목 (SC-012 Error)", () => {
  it("합성 usage 에 --bar 를 넣고 선언이 없으면 실패로 지목한다", async () => {
    const { usageDriftIssues } = await import("../../scripts/check-usage-drift.js");
    const catalog: UsageCatalog = {
      locale: "en",
      texts: { "usage.synthetic2": "Usage: adde synthetic2 --bar" },
    };
    const checks: UsageCheck[] = [{ usageKey: "usage.synthetic2", declaredFlags: [] }];
    const issues: DriftIssue[] = usageDriftIssues(catalog, checks);
    expect(
      issues.some((i) => i.kind === "undeclared" && i.flag === "--bar"),
      "--bar 가 undeclared 로 지목되지 않음",
    ).toBe(true);
  });
});

describe("per-command usage 가 다른 명령에만 선언된 플래그를 광고하면 undeclared (SC-012 Error, DEC-004)", () => {
  it("명령 A(나열식, --json 만 선언)의 usage 가 명령 B 전용 --engine 을 광고하면 cross-command 위반으로 검출한다", async () => {
    const { usageDriftIssues } = await import("../../scripts/check-usage-drift.js");
    const catalog: UsageCatalog = {
      locale: "en",
      texts: {
        // 명령 A(예: lane show 계열) — --json 만 선언했는데 usage 문면이 --engine 도 광고(cross-command 오광고).
        "usage.aSynthetic": "Usage: adde a <proj> <lane> [--json] [--engine <name>]",
        // 명령 B(예: logs) — --engine 을 실제로 선언·광고하는 쪽.
        "usage.bSynthetic": "Usage: adde b <proj> <lane> [--json] [--engine <name>]",
      },
    };
    const checks: UsageCheck[] = [
      { usageKey: "usage.aSynthetic", declaredFlags: ["--json"] },
      { usageKey: "usage.bSynthetic", declaredFlags: ["--json", "--engine"] },
    ];
    const issues: DriftIssue[] = usageDriftIssues(catalog, checks);
    // 강화 전(전역 union)이면 --engine 이 checks 전체 선언 합집합에 있어 A 에서도 놓쳤을 위반 —
    // 강화 후(per-command: 그 명령 선언 ∪ 전역)에는 A 의 광고가 A 자신의 선언에 없어 undeclared 로 검출된다.
    expect(
      issues.some(
        (i) => i.usageKey === "usage.aSynthetic" && i.kind === "undeclared" && i.flag === "--engine",
      ),
      "명령 A 가 광고한 타 명령(B) 전용 --engine 이 cross-command undeclared 로 검출되지 않음",
    ).toBe(true);
    // B 자신은 --engine 을 선언했으므로 위반 없음(대조군).
    expect(
      issues.some((i) => i.usageKey === "usage.bSynthetic" && i.kind === "undeclared"),
      "명령 B 자신의 선언 플래그가 undeclared 로 오탐됨",
    ).toBe(false);
  });

  it("요약/그룹 summary usage(declaredFlags=[])는 전역 union 을 유지해 동일 플래그 광고를 오탐하지 않는다", async () => {
    const { usageDriftIssues } = await import("../../scripts/check-usage-drift.js");
    const catalog: UsageCatalog = {
      locale: "en",
      texts: {
        // summary usage — 여러 명령 플래그를 한데 나열하는 문안(예: usage.main 류). --engine 은
        // b 명령이 선언했으므로 전역 union 에 포함되어 summary 에서는 undeclared 가 아니다.
        "usage.summarySynthetic": "Usage: adde <command> [--json] [--engine <name>]",
        "usage.bSynthetic2": "Usage: adde b <proj> <lane> [--json] [--engine <name>]",
      },
    };
    const checks: UsageCheck[] = [
      { usageKey: "usage.summarySynthetic", declaredFlags: [] },
      { usageKey: "usage.bSynthetic2", declaredFlags: ["--json", "--engine"] },
    ];
    const issues: DriftIssue[] = usageDriftIssues(catalog, checks);
    expect(
      issues.some((i) => i.usageKey === "usage.summarySynthetic" && i.kind === "undeclared"),
      "summary usage 의 --engine 광고가 전역 union 대비 오탐(undeclared)됨 — per-command 좁힘이 summary 에도 잘못 적용됨",
    ).toBe(false);
  });
});
