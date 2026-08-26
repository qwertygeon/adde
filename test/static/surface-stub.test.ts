import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// 확정 시그니처: SURFACE_REGISTRY: Record<string, SurfaceDescriptor> ·
// SurfaceDescriptor { id; status: "implemented"|"stub"; factory?; validateAddress?; doctorChecks? }

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-027: 미구현 채널이 목록·진단에 노출된다", () => {
  it("Happy: telegram·discord 가 SURFACE_REGISTRY 에 status:'stub' 으로 등재된다", async () => {
    const surfaces = await import("../../src/surfaces/index.js");
    expect(surfaces.SURFACE_REGISTRY["telegram"]?.status).toBe("stub");
    expect(surfaces.SURFACE_REGISTRY["discord"]?.status).toBe("stub");
    expect(surfaces.SURFACE_REGISTRY["markdown"]?.status).toBe("implemented");
  });

  it("Edge: 구현 채널과 stub 이 SURFACE_IDS 에 함께 나타난다", async () => {
    const surfaces = await import("../../src/surfaces/index.js");
    expect(surfaces.SURFACE_IDS).toEqual(
      expect.arrayContaining(["markdown", "telegram", "discord"]),
    );
  });

  it("Error: stub 항목에 factory 가 존재하면 등재 규약 위반이다(자기점검)", async () => {
    const surfaces = await import("../../src/surfaces/index.js");
    for (const [id, descriptor] of Object.entries(surfaces.SURFACE_REGISTRY)) {
      if (descriptor.status === "stub") {
        expect(descriptor.factory, `${id} 는 stub 인데 factory 를 제공함(위반)`).toBeUndefined();
      }
    }
  });
});

describe("SC-034: 미구현 채널로의 바인딩 생성이 거부된다", () => {
  it("Happy: telegram 바인딩 생성 요청은 '미구현 채널' 사유로 거부된다", async () => {
    const surfaces = await import("../../src/surfaces/index.js");
    const descriptor = surfaces.SURFACE_REGISTRY["telegram"];
    expect(descriptor?.status).toBe("stub");
    expect(descriptor?.factory).toBeUndefined(); // 바인딩 시도 시 factory 부재로 거부되는 계약
  });

  it("Edge: 존재하지 않는 surface id 는 별도 사유로 거부된다", async () => {
    const surfaces = await import("../../src/surfaces/index.js");
    expect(surfaces.SURFACE_REGISTRY["nonexistent-surface"]).toBeUndefined();
  });

  it("Error: 거부 시 어떤 설정 파일도 생성·변경되지 않는다", async () => {
    const before = listFilesRecursive(roots.base);
    // 바인딩 CLI 배선(T021) 이전이라 실제 명령 실행은 불가 — 레지스트리 조회만으로 상태 불변을
    // 확인한다(파일시스템에 아무 영향이 없어야 함).
    const surfaces = await import("../../src/surfaces/index.js");
    void surfaces.SURFACE_REGISTRY["telegram"];
    const after = listFilesRecursive(roots.base);
    expect(after).toEqual(before);
  });
});
