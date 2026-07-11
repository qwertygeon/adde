import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS, findCommand } from "../../src/cli/spec.js";
import { SOURCE_IDS } from "../../src/src-adapters/index.js";

// 정적 구조 점검 — SC-001(4소비자 단일 입력)·SC-009(명령 체계 보존)·SC-013(확장 구조 불변).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliDir = path.join(repoRoot, "src", "cli");

function readSrc(file: string): string {
  return fs.readFileSync(path.join(cliDir, file), "utf8");
}

describe("SC-001: 명령별 하드코딩 파싱 잔존 0 — 4소비자가 단일 parseCommand 경유", () => {
  it("run.ts 에 위치 구조분해(const [first, second])가 잔존하지 않는다", () => {
    expect(readSrc("run.ts")).not.toMatch(/const\s*\[\s*first\s*,\s*second\s*\]/);
  });

  it("ops.ts 에 rest.includes(/rest.find( 하드코딩 판정이 잔존하지 않는다", () => {
    const src = readSrc("ops.ts");
    expect(src).not.toMatch(/rest\.includes\(/);
    expect(src).not.toMatch(/rest\.find\(/);
  });

  it("lane.ts 에 자체 parseArgs·ADD_VALUE_KEYS 가 잔존하지 않는다", () => {
    const src = readSrc("lane.ts");
    expect(src).not.toMatch(/function\s+parseArgs\(/);
    expect(src).not.toMatch(/\bADD_VALUE_KEYS\b/);
  });

  it("proj.ts 에 rest.includes(/rest.find( 하드코딩 판정이 잔존하지 않는다", () => {
    const src = readSrc("proj.ts");
    expect(src).not.toMatch(/rest\.includes\(/);
    expect(src).not.toMatch(/rest\.find\(/);
  });

  it("run·ops·lane·proj·completion 모두 parseCommand( 또는 그 파생 헬퍼를 경유한다", () => {
    for (const file of ["run.ts", "ops.ts", "lane.ts", "proj.ts"]) {
      expect(readSrc(file), `${file} 에 parseCommand( 호출이 없음`).toMatch(/parseCommand\(/);
    }
    // completion.ts 는 파싱이 아니라 파생 헬퍼(flagNames 등)를 경유 — 하드코딩 상수 직접 join 제거.
    expect(readSrc("completion.ts")).not.toMatch(/c\.flags\.join\(/);
  });

  it("spec.ts 에 FlagSpec·SubSpec 구조화 타입이 존재한다", () => {
    const src = readSrc("spec.ts");
    expect(src).toMatch(/interface\s+FlagSpec\b/);
    expect(src).toMatch(/interface\s+SubSpec\b/);
  });
});

describe("SC-009: 명령 체계가 개명·계층 재편 없이 보존된다", () => {
  it("COMMAND_SPECS 이름 집합이 정확히 일치한다(개명 0건)", () => {
    const expected = new Set([
      "up",
      "down",
      "restart",
      "status",
      "doctor",
      "logs",
      "sessions",
      "lane",
      "proj",
      "init",
      "alias",
      "completion",
      "__daemon",
    ]);
    const actual = new Set(COMMAND_SPECS.map((c) => c.name));
    expect(actual).toEqual(expected);
  });

  it("lane 하위명령이 add|ls|show|rm 을 포함한다", () => {
    const lane = findCommand("lane");
    const subNames = (lane?.subs ?? []).map((s: { name: string }) => s.name);
    for (const s of ["add", "ls", "show", "rm"]) expect(subNames).toContain(s);
  });

  it("proj 하위명령이 ls|rm 을 포함한다", () => {
    const proj = findCommand("proj");
    const subNames = (proj?.subs ?? []).map((s: { name: string }) => s.name);
    for (const s of ["ls", "rm"]) expect(subNames).toContain(s);
  });
});

describe("SC-013: 확장 구조가 불변 — SOURCE_REGISTRY 파생·FLAG_VALUES 미러·eager import 금지", () => {
  it("FLAG_VALUES['--source'] 는 SOURCE_IDS 와 일치한다(값 집합, 순서 무관)", async () => {
    const { FLAG_VALUES } = await import("../../src/cli/spec.js");
    const mirror = [...(FLAG_VALUES["--source"] ?? [])].sort();
    const derived = [...SOURCE_IDS].sort();
    expect(mirror).toEqual(derived);
  });

  it("spec.ts 는 src-adapters 를 eager import 하지 않는다(startup 비용 회피, NFR-005)", () => {
    const src = readSrc("spec.ts");
    expect(src).not.toMatch(/from\s+["']\.\.\/src-adapters/);
  });
});
