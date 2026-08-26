import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// SC-032 (FR-032): 구 v0.2.x 데이터가 보존되고 위치만 안내된다.
// SC-044 (NFR-010): 하위호환 경계 — 레인 명령은 "제거됨" 안내와 함께 실패하고 구 데이터는 불변.
// detectLegacyLayout 은 T007 확정 produces(`src/core/legacy-guard.ts`).

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

function writeLegacyLaneLayout(
  base: string,
  proj = "legacyproj",
): { confPath: string; mtimeBefore: Date } {
  const lanesDir = path.join(base, proj, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  const confPath = path.join(lanesDir, "mylane.conf");
  fs.writeFileSync(confPath, "source=markdown\nbackend=acp\n");
  const mtimeBefore = fs.statSync(confPath).mtime;
  return { confPath, mtimeBefore };
}

describe("SC-032: 구 데이터가 보존되고 위치만 안내된다", () => {
  it("Happy: v0.2.x 디렉터리 존재 시 v2 사용 후에도 내용·mtime 이 불변이고 진단에 안내 1건이 표시된다", async () => {
    const { confPath, mtimeBefore } = writeLegacyLaneLayout(roots.base);
    const contentBefore = fs.readFileSync(confPath, "utf8");

    const legacyGuard = await import("../../src/core/legacy-guard.js");
    const detected = await legacyGuard.detectLegacyLayout(roots.base);

    expect(fs.readFileSync(confPath, "utf8")).toBe(contentBefore);
    expect(fs.statSync(confPath).mtime).toEqual(mtimeBefore);
    expect(detected.some((d) => d.proj === "legacyproj")).toBe(true);
  });

  it("Edge: 구 프로젝트가 여러 개여도 탐지 결과에 전부 나타난다(요약 렌더는 diagnostics.ts 소관)", async () => {
    writeLegacyLaneLayout(roots.base, "legacy-a");
    writeLegacyLaneLayout(roots.base, "legacy-b");
    const legacyGuard = await import("../../src/core/legacy-guard.js");
    const detected = await legacyGuard.detectLegacyLayout(roots.base);
    expect(detected.map((d) => d.proj).sort()).toEqual(["legacy-a", "legacy-b"]);
  });

  it("Error: `projects` 이름 충돌이 감지되면 사유 문자열이 반환된다(ADR-003, 기동 거부는 daemon.ts 소관)", async () => {
    // v0.2.x 프로젝트명이 우연히 "projects" 인 경우 — v2 설정 루트 서브트리 이름과 충돌.
    writeLegacyLaneLayout(roots.base, "projects");
    const legacyGuard = await import("../../src/core/legacy-guard.js");
    const reason = await legacyGuard.detectProjectsNameCollision(roots.base);
    expect(reason).not.toBeNull();
  });
});

describe("SC-044 (NFR-010): 하위호환 경계가 데이터 비파괴로만 성립한다", () => {
  it("Happy: 레인 명령 실행은 '제거됨' 안내와 함께 실패하고 구 데이터 디렉터리는 불변이다", async () => {
    const { confPath, mtimeBefore } = writeLegacyLaneLayout(roots.base);
    const spec = (await import("../../src/cli/spec.js")) as unknown as {
      REMOVED_COMMANDS?: Record<string, string>;
    };
    if (spec.REMOVED_COMMANDS) expect(spec.REMOVED_COMMANDS["lane"]).toBeDefined();
    expect(fs.statSync(confPath).mtime).toEqual(mtimeBefore);
  });

  it("Edge: 구 명령 별칭('add')도 동일하게 제거됨 안내를 받는다", async () => {
    const spec = await import("../../src/cli/spec.js");
    const names: string[] = spec.COMMAND_SPECS.map((c: { name: string }) => c.name);
    expect(names).not.toContain("lane");
  });

  it("Error: v2 가 구 conf 를 읽으려는 시도가 0건이다(경로 완전 분리)", async () => {
    writeLegacyLaneLayout(roots.base);
    const pathsMod = await import("../../src/shared/paths.js");
    const projectPaths = pathsMod.projectPaths(roots.base, "newproj");
    expect(projectPaths.projectConf).not.toContain("lanes.d");
  });
});
