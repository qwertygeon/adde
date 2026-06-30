import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { lanePaths, expandTilde } from "../../src/shared/paths.js";

describe("expandTilde", () => {
  it("'~' 를 홈 디렉터리로 확장한다", () => {
    expect(expandTilde("~")).toBe(homedir());
  });
  it("'~/' 접두사를 홈 기준으로 확장한다", () => {
    expect(expandTilde("~/Documents/x")).toBe(`${homedir()}/Documents/x`);
  });
  it("절대경로·상대경로는 그대로 둔다", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
    expect(expandTilde("rel/path")).toBe("rel/path");
  });
  it("'~user' 형태는 확장하지 않는다(미지원)", () => {
    expect(expandTilde("~other/x")).toBe("~other/x");
  });
});

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

describe("lanePaths 경로 탈출 차단", () => {
  it("lane 에 디렉터리 탈출(..)이 있으면 throw", () => {
    expect(() => lanePaths("/tmp/adde-test", "proj", "../../etc")).toThrow();
  });
  it("proj 에 디렉터리 탈출(..)이 있으면 throw", () => {
    expect(() => lanePaths("/tmp/adde-test", "../../etc", "lane")).toThrow();
  });
  it("경로 구분자가 든 lane 은 throw", () => {
    expect(() => lanePaths("/tmp/adde-test", "proj", "a/b")).toThrow();
  });
  it("정상 식별자(영숫자·_·-)는 허용", () => {
    expect(() => lanePaths("/tmp/adde-test", "proj_1", "telegram-claude")).not.toThrow();
  });
});
