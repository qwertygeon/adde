import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  projectPaths,
  sessionPaths,
  expandTilde,
  normalizeUserPath,
} from "../../src/shared/paths.js";

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

describe("normalizeUserPath", () => {
  it("이스케이프된 공백을 제거한다", () => {
    expect(normalizeUserPath("/a/Mobile\\ Documents/x")).toBe("/a/Mobile Documents/x");
  });
  it("이스케이프된 틸드·괄호 등 셸 메타문자를 제거한다", () => {
    expect(normalizeUserPath("/a/iCloud\\~md\\~obsidian")).toBe("/a/iCloud~md~obsidian");
    expect(normalizeUserPath("/a/f\\(1\\)")).toBe("/a/f(1)");
  });
  it("한 경로의 다중 이스케이프를 모두 제거한다", () => {
    expect(
      normalizeUserPath("/Users/x/Library/Mobile\\ Documents/iCloud\\~md\\~obsidian/Documents"),
    ).toBe("/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents");
  });
  it("일반문자·경로구분자 앞의 백슬래시(합법 파일명)는 보존한다", () => {
    expect(normalizeUserPath("/a/we\\ird")).toBe("/a/we\\ird"); // \i 는 메타문자 아님 → 보존
    expect(normalizeUserPath("/a/b\\/c")).toBe("/a/b\\/c"); // \/ 보존
  });
  it("이스케이프 없는 경로는 그대로 둔다", () => {
    expect(normalizeUserPath("/abs/plain/path")).toBe("/abs/plain/path");
    expect(normalizeUserPath("rel/inbox.md")).toBe("rel/inbox.md");
  });
});

// v2 재작성(T-D11 처분 — 레인축 → 프로젝트·세션축, lanePaths 제거) — projectPaths/sessionPaths 가
// proj/sid 파라미터만으로 경로를 구성하는지(하드코딩 금지) + 세션 간 교차 접근 차단을 검증한다.

describe("projectPaths·sessionPaths (프로젝트·세션 경로 동적 구성)", () => {
  it("base/proj 파라미터로 프로젝트 경로가 구성된다", () => {
    const paths = projectPaths("/tmp/adde-test", "myproj");
    expect(paths.root).toContain("myproj");
    expect(paths.sessionsDir).toContain("myproj");
    expect(paths.envFile).toContain("myproj");
  });

  it("base/proj/sid 파라미터로 세션 경로가 구성된다", () => {
    const paths = sessionPaths("/tmp/adde-test", "myproj", "sess-1");
    expect(paths.queueDir).toContain("myproj");
    expect(paths.queueDir).toContain("sess-1");
    expect(paths.processingDir).toContain("sess-1");
    expect(paths.recordFile).toContain("sess-1");
  });

  it("세션 A 와 세션 B 의 경로가 다르다 — 교차 접근 방지", () => {
    const pathsA = sessionPaths("/tmp/adde-test", "proj", "sess-a");
    const pathsB = sessionPaths("/tmp/adde-test", "proj", "sess-b");
    expect(pathsA.queueDir).not.toBe(pathsB.queueDir);
    expect(pathsA.processingDir).not.toBe(pathsB.processingDir);
  });

  it("세션 B 경로가 세션 A 경로 문자열에 포함되지 않는다 — 교차 접근 0건", () => {
    const pathsA = sessionPaths("/tmp/adde-test", "proj", "sess-a");
    const pathsB = sessionPaths("/tmp/adde-test", "proj", "sess-b");
    expect(pathsA.queueDir).not.toContain("sess-b");
    expect(pathsB.queueDir).not.toContain("sess-a");
  });

  it("base override 가 모든 경로에 적용된다", () => {
    const customBase = "/custom/base";
    const paths = projectPaths(customBase, "proj");
    expect(paths.root.startsWith(customBase)).toBe(true);
    expect(paths.sessionsDir.startsWith(customBase)).toBe(true);
  });

  it("sessions.d 경로가 존재한다 — 세션 레코드 스캔 경로", () => {
    const paths = projectPaths("/tmp/adde-test", "proj");
    expect(paths.sessionsDir).toBeDefined();
    expect(typeof paths.sessionsDir).toBe("string");
  });

  it("recordFile 이 세션 sid 를 경로에 포함한다", () => {
    const paths = sessionPaths("/tmp/adde-test", "proj", "sess-1");
    expect(paths.recordFile).toContain("sess-1");
  });
});

describe("projectPaths·sessionPaths 경로 탈출 차단", () => {
  it("sid 에 디렉터리 탈출(..)이 있으면 throw", () => {
    expect(() => sessionPaths("/tmp/adde-test", "proj", "../../etc")).toThrow();
  });
  it("proj 에 디렉터리 탈출(..)이 있으면 throw", () => {
    expect(() => projectPaths("/tmp/adde-test", "../../etc")).toThrow();
  });
  it("경로 구분자가 든 sid 는 throw", () => {
    expect(() => sessionPaths("/tmp/adde-test", "proj", "a/b")).toThrow();
  });
  it("정상 식별자(영숫자·_·-)는 허용", () => {
    expect(() => sessionPaths("/tmp/adde-test", "proj_1", "sess-1a")).not.toThrow();
  });
});
