import { describe, expect, it } from "vitest";
import { lanePaths } from "../../src/shared/paths.js";

// SC-025 일부: lanePaths 가 lane 파라미터로만 경로를 구성(하드코딩 금지)

describe("lanePaths (SC-025 레인 경로 동적 구성)", () => {
  it("base/proj/lane 파라미터로 경로를 구성한다", () => {
    const paths = lanePaths("/tmp/adde-test", "myproj", "telegram");
    expect(paths.queueDir).toContain("myproj");
    expect(paths.queueDir).toContain("telegram");
    expect(paths.processingDir).toContain("myproj");
    expect(paths.processingDir).toContain("telegram");
    expect(paths.outDir).toContain("myproj");
    expect(paths.outDir).toContain("telegram");
    expect(paths.stateDir).toContain("myproj");
    expect(paths.stateDir).toContain("telegram");
  });

  it("레인 A 와 레인 B 의 경로가 다르다 — 교차 접근 방지", () => {
    const pathsA = lanePaths("/tmp/adde-test", "proj", "lane-a");
    const pathsB = lanePaths("/tmp/adde-test", "proj", "lane-b");
    expect(pathsA.queueDir).not.toBe(pathsB.queueDir);
    expect(pathsA.stateDir).not.toBe(pathsB.stateDir);
    expect(pathsA.outDir).not.toBe(pathsB.outDir);
  });

  it("레인 B 경로가 레인 A 경로 문자열에 포함되지 않는다 — 교차 접근 0건", () => {
    const pathsA = lanePaths("/tmp/adde-test", "proj", "lane-a");
    const pathsB = lanePaths("/tmp/adde-test", "proj", "lane-b");
    // queueDir of A should not mention lane-b
    expect(pathsA.queueDir).not.toContain("lane-b");
    expect(pathsB.queueDir).not.toContain("lane-a");
  });

  it("base override 가 모든 경로에 적용된다", () => {
    const customBase = "/custom/base";
    const paths = lanePaths(customBase, "proj", "telegram");
    expect(paths.queueDir.startsWith(customBase)).toBe(true);
    expect(paths.stateDir.startsWith(customBase)).toBe(true);
  });

  it("lanesDir 이 존재한다 — conf 파일 스캔 경로", () => {
    const paths = lanePaths("/tmp/adde-test", "proj", "telegram");
    expect(paths.lanesDir).toBeDefined();
    expect(typeof paths.lanesDir).toBe("string");
  });

  it("sessionIdFile 이 stateDir 내에 위치한다", () => {
    const paths = lanePaths("/tmp/adde-test", "proj", "telegram");
    expect(paths.sessionIdFile.startsWith(paths.stateDir)).toBe(true);
  });

  it("transcriptLog 이 stateDir 내에 위치한다", () => {
    const paths = lanePaths("/tmp/adde-test", "proj", "telegram");
    expect(paths.transcriptLog.startsWith(paths.stateDir)).toBe(true);
  });

  it("envFile 이 stateDir 내에 위치한다", () => {
    const paths = lanePaths("/tmp/adde-test", "proj", "telegram");
    expect(paths.envFile.startsWith(paths.stateDir)).toBe(true);
  });
});
