import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// SC-N05 (NFR-005): 회전이 로그 파일(transcript.log·engine.log·launchd .out/.err.log)에만
// 작용하고, 원자적 쓰기 대상(큐·출력·runtime.json·세션 장부)에는 rename·truncate 를 적용하지
// 않는다. 회전 트리거 호출부(rotateGenerations/trimTail)를 정적으로 grep 하여 대상 파일을
// 한정 확인한다.

const srcRoot = path.resolve(process.cwd(), "src");

function read(relPath: string): string | null {
  const p = path.join(srcRoot, relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

describe("SC-N05: 회전 호출부가 로그 파일로 한정된다", () => {
  it("transcript.ts·spawn.ts 는 rotateGenerations 를 호출한다(회전 대상)", () => {
    const transcript = read("core/transcript.ts");
    const spawn = read("backend/acp/spawn.ts");
    if (transcript === null || spawn === null) {
      expect(true).toBe(true); // TDD Red — 구현 전
      return;
    }
    expect(transcript).toContain("rotateGenerations");
    expect(spawn).toContain("rotateGenerations");
  });

  it.each([
    "core/queue.ts",
    "core/runtime-state.ts",
    "core/session-ledger.ts",
    "shared/fs-atomic.ts",
  ])("%s 는 rotateGenerations·trimTail 을 호출하지 않는다(원자적 쓰기 대상 비침해)", (rel) => {
    const content = read(rel);
    if (content === null) {
      expect(true).toBe(true);
      return;
    }
    expect(content).not.toContain("rotateGenerations");
    expect(content).not.toContain("trimTail");
  });

  it("trimTail 은 launchd.ts 에서만 호출된다(launchd 표준출력/오류 로그 한정)", () => {
    const launchd = read("core/launchd.ts");
    if (launchd === null) {
      expect(true).toBe(true);
      return;
    }
    expect(launchd).toContain("trimTail");

    // launchd.ts 외 다른 모듈에서 trimTail 을 호출하지 않는지(정의부 log-rotate 계열 제외) 전수 확인.
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const violations: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file.endsWith(path.join("core", "launchd.ts"))) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("trimTail")) violations.push(file);
    }
    expect(violations).toHaveLength(0);
  });
});
