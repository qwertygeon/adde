import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findSub, subFlagNames } from "../../src/cli/spec.js";

// 017-lane-set D3 (5a AUTHORING) — CLI 표면 정적 단정. findSub/subFlagNames 는 기존 export 라
// static import 가 안전(B1/B2 미착지여도 파일 자체는 로드되고, 개별 it 만 RED — PROC-R15).
// LANE_SET_IDENTITY_FLAGS 는 신규 export 라 named import 시 미착지 구간에서 SyntaxError 로 파일
// 전체가 붕괴할 수 있어 네임스페이스 동적 import 로 접근한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const EXPECTED_SET_EDIT_FLAGS = [
  "--perm-tier",
  "--allowlist",
  "--denylist",
  "--hard-deny",
  "--cwd",
  "--engine-args",
  "--lang",
  "--file-mode",
  "--chat-id",
  "--allow-from",
  "--root",
  "--inbox",
  "--approvals",
  "--outbox",
] as const;

const IDENTITY_EXCLUDED_FLAGS = [
  "--source",
  "--token-stdin",
  "--safe-defaults",
  "--force",
  "--interactive",
  "--no-interactive",
] as const;

describe("CLI 표면 등록 (SC-016)", () => {
  it("findSub('lane','set') 이 정의되고 위치 인자가 [proj, lane] 이며 편집 플래그가 비어있지 않다", () => {
    const sub = findSub("lane", "set");
    expect(sub, "lane set 서브스펙이 spec.ts 에 등록되어야 한다").toBeDefined();
    expect(sub?.positional).toEqual(["proj", "lane"]);
    expect(sub?.flags.length ?? 0).toBeGreaterThan(0);
  });

  it("subFlagNames('lane','set') 에 14개 편집 플래그가 전부 포함된다", () => {
    const names = subFlagNames("lane", "set");
    for (const f of EXPECTED_SET_EDIT_FLAGS) {
      expect(names, `${f} 가 lane set 플래그에 없음`).toContain(f);
    }
  });
});

describe("편집 플래그 부분집합 (SC-019)", () => {
  it("set 플래그 집합 = add 플래그 − {정체성·token-stdin·safe-defaults·force·interactive·no-interactive}", () => {
    const addNames = new Set(subFlagNames("lane", "add"));
    const setNames = new Set(subFlagNames("lane", "set"));
    const expected = new Set(
      [...addNames].filter((n) => !(IDENTITY_EXCLUDED_FLAGS as readonly string[]).includes(n)),
    );
    expect(setNames).toEqual(expected);
  });

  it("제외 대상 플래그는 set 에 존재하지 않는다", () => {
    const setNames = subFlagNames("lane", "set");
    for (const f of IDENTITY_EXCLUDED_FLAGS) {
      expect(setNames, `${f} 는 lane set 에 없어야 한다`).not.toContain(f);
    }
  });
});

describe("토큰 미노출 (SC-021)", () => {
  it("set 플래그에 --token·--token-stdin 이 없다", () => {
    const setNames = subFlagNames("lane", "set");
    expect(setNames).not.toContain("--token");
    expect(setNames).not.toContain("--token-stdin");
  });

  it("LANE_SET_IDENTITY_FLAGS 는 정확히 4개 정체성 플래그이며 LANE_SET_FLAGS 와 disjoint 하다", async () => {
    const spec = (await import("../../src/cli/spec.js")) as unknown as {
      LANE_SET_IDENTITY_FLAGS?: readonly string[];
    };
    const identityFlags = spec.LANE_SET_IDENTITY_FLAGS;
    expect(identityFlags, "LANE_SET_IDENTITY_FLAGS 가 spec.ts 에 export 되어야 한다").toBeDefined();
    expect([...(identityFlags ?? [])].sort()).toEqual(
      ["--acp-version", "--backend", "--engine", "--source"].sort(),
    );
    const setNames = new Set(subFlagNames("lane", "set"));
    for (const f of identityFlags ?? []) {
      expect(setNames.has(f), `${f} 는 LANE_SET_FLAGS 에 없어야 한다(자동완성 미노출)`).toBe(false);
    }
  });
});

describe("안전 경계 — set 코드가 gate 미의존 (SC-018 보조)", () => {
  it("lane.ts·lane-config.ts 가 src/gate 를 import 하지 않는다", () => {
    const laneTs = fs.readFileSync(path.join(repoRoot, "src/cli/lane.ts"), "utf8");
    const laneConfigTs = fs.readFileSync(path.join(repoRoot, "src/core/lane-config.ts"), "utf8");
    expect(laneTs).not.toMatch(/from\s+["']\.\.\/gate/);
    expect(laneConfigTs).not.toMatch(/from\s+["']\.\.\/gate/);
  });
});
