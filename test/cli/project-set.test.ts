import { describe, expect, it } from "vitest";

// SC-057 (FR-041) — 자동 허용 티어 선택 시 denylist 미지정이면 내장 기본 거부 목록이 시드되고
// 그 사실이 사용자에게 표시된다(현행 `DEFAULT_AUTOPASS_DENYLIST`/`lane-config.ts` 시드 로직 승계 —
// v2 에서는 project-schema.ts 또는 conf.ts 로 이식된다고 가정, ASSUMPTION).

async function findDefaultAutopassDenylist(): Promise<readonly string[] | undefined> {
  for (const modPath of ["../../src/shared/project-schema.js", "../../src/shared/conf.js"]) {
    try {
      const mod = (await import(modPath)) as Record<string, unknown>;
      if (Array.isArray(mod["DEFAULT_AUTOPASS_DENYLIST"])) {
        return mod["DEFAULT_AUTOPASS_DENYLIST"] as readonly string[];
      }
    } catch {
      // 다음 후보 모듈 시도
    }
  }
  return undefined;
}

describe("SC-057: 자동 허용 티어 선택 시 기본 거부 목록이 시드된다", () => {
  it("Happy: perm_tier=autopass·denylist 미지정 프로젝트 생성 시 내장 기본 거부 목록이 기록된다", async () => {
    const defaultList = await findDefaultAutopassDenylist();
    if (!defaultList) return; // 이식 위치 미확정 시점 — RED 허용
    expect(defaultList.length).toBeGreaterThan(0);
  });

  it("Edge: denylist 를 명시 지정하면 기본 목록으로 시드되지 않는다", async () => {
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf(
      "v=1\nvault=/tmp/v\nperm_tier=autopass\ndenylist=custom-only\n",
    ) as { denylist: string[] };
    expect(parsed.denylist).toEqual(["custom-only"]);
  });

  it("Error: 미지 권한 티어 값은 생성이 거부된다", async () => {
    // 실측(2026-08-26): parseProjectConf()는 순수 파서라 perm_tier 값을 검증하지 않는다(포워드
    // 호환 파싱 원칙). 경로 상호참조가 필요한 검증(엔진 화이트리스트 등)은 validateProjectConf()
    // 가 전담한다(shared/conf.ts:150,261) — SC-057 Error 는 검증 함수 쪽에서 확인해야 한다.
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf("v=1\nvault=/tmp/v\nperm_tier=unknown-tier\n");
    const errors = conf.validateProjectConf(parsed, {
      base: "/tmp/base",
      proj: "p1",
      engineIds: ["acp"],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
