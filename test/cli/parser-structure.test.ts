import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS, findCommand } from "../../src/cli/spec.js";
import { SURFACE_IDS } from "../../src/surfaces/index.js";

// 정적 구조 점검(구 spec 세대 번호 — 현재 spec 의 SC-001·SC-009·SC-013 과 무관, code-is-truth 로
// 구조 자체만 v2 표면에 맞춰 갱신). 4소비자 단일 입력·명령 체계 보존·확장 구조 불변을 검사한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliDir = path.join(repoRoot, "src", "cli");

function readSrc(file: string): string {
  return fs.readFileSync(path.join(cliDir, file), "utf8");
}

describe("명령별 하드코딩 파싱 잔존 0 — 소비자가 단일 parseCommand 경유", () => {
  it("run.ts 에 위치 구조분해(const [first, second])가 잔존하지 않는다", () => {
    expect(readSrc("run.ts")).not.toMatch(/const\s*\[\s*first\s*,\s*second\s*\]/);
  });

  it("ops.ts 에 rest.includes(/rest.find( 하드코딩 판정이 잔존하지 않는다", () => {
    const src = readSrc("ops.ts");
    expect(src).not.toMatch(/rest\.includes\(/);
    expect(src).not.toMatch(/rest\.find\(/);
  });

  it("project.ts·session.ts·bind.ts 에 자체 parseArgs 가 잔존하지 않는다", () => {
    for (const file of ["project.ts", "session.ts", "bind.ts"]) {
      const src = readSrc(file);
      expect(src, `${file} 에 자체 parseArgs( 잔존`).not.toMatch(/function\s+parseArgs\(/);
    }
  });

  it("project.ts·session.ts·bind.ts 에 rest.includes(/rest.find( 하드코딩 판정이 잔존하지 않는다", () => {
    for (const file of ["project.ts", "session.ts", "bind.ts"]) {
      const src = readSrc(file);
      expect(src, `${file} 에 rest.includes( 잔존`).not.toMatch(/rest\.includes\(/);
      expect(src, `${file} 에 rest.find( 잔존`).not.toMatch(/rest\.find\(/);
    }
  });

  it("run·ops·project·session·bind·vault·completion 모두 parseCommand( 또는 그 파생 헬퍼를 경유한다", () => {
    for (const file of ["run.ts", "ops.ts", "project.ts", "session.ts", "bind.ts", "vault.ts"]) {
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

describe("명령 체계 — v2 세션 축 표면(FR-030) 보존", () => {
  it("COMMAND_SPECS 이름 집합이 정확히 일치한다(레인 명령군 제거·세션 축 표면으로 교체)", () => {
    const expected = new Set([
      "init",
      "up",
      "down",
      "restart",
      "status",
      "doctor",
      "logs",
      "project",
      "session",
      "bind",
      "vault",
      "completion",
      "alias",
      "__daemon",
      "factory-reset", // 006(FR-030) — 공장 초기화 최상위 명령 신설(A-P005 예외 승계).
    ]);
    const actual = new Set(COMMAND_SPECS.map((c) => c.name));
    expect(actual).toEqual(expected);
  });

  it("project 하위명령이 add|set|show|ls|rm 을 포함한다", () => {
    const project = findCommand("project");
    const subNames = (project?.subs ?? []).map((s: { name: string }) => s.name);
    for (const s of ["add", "set", "show", "ls", "rm"]) expect(subNames).toContain(s);
  });

  it("session 하위명령이 new|ls|show|clear|rm 을 포함한다", () => {
    const session = findCommand("session");
    const subNames = (session?.subs ?? []).map((s: { name: string }) => s.name);
    for (const s of ["new", "ls", "show", "clear", "rm"]) expect(subNames).toContain(s);
  });

  it("bind 하위명령이 add|rm|ls 를 포함한다", () => {
    const bind = findCommand("bind");
    const subNames = (bind?.subs ?? []).map((s: { name: string }) => s.name);
    for (const s of ["add", "rm", "ls"]) expect(subNames).toContain(s);
  });
});

describe("확장 구조가 불변 — SURFACE_REGISTRY 파생·FLAG_VALUES 미러·eager import 금지", () => {
  it("FLAG_VALUES['--surface'] 는 SURFACE_IDS 와 일치한다(값 집합, 순서 무관)", async () => {
    const { FLAG_VALUES } = await import("../../src/cli/spec.js");
    const mirror = [...(FLAG_VALUES["--surface"] ?? [])].sort();
    const derived = [...SURFACE_IDS].sort();
    expect(mirror).toEqual(derived);
  });

  it("spec.ts 는 surfaces 를 eager import 하지 않는다(startup 비용 회피, NFR-005)", () => {
    const src = readSrc("spec.ts");
    expect(src).not.toMatch(/from\s+["']\.\.\/surfaces/);
  });
});
