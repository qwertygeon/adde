import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_IDS, SOURCE_REGISTRY } from "../../src/src-adapters/index.js";

// SC-001 (FR-001): 지원 소스 목록이 레지스트리(SOURCE_REGISTRY)에서 파생되고, 지원 소스를
// 정의하는 별개 하드코딩 배열(구 SUPPORTED_SOURCES/SupportedSource)이 존재하지 않는다. 모든
// 소비 지점(lane-config·diagnostics 등)은 레지스트리 파생 목록(SOURCE_IDS)을 사용한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = path.join(repoRoot, "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("SC-001: 지원 소스 단일 SoT — 별개 하드코딩 배열 부재", () => {
  it("src/ 내 SUPPORTED_SOURCES 식별자가 존재하지 않는다(구 하드코딩 배열 제거)", () => {
    const hits = listTsFiles(srcDir).filter((f) => /\bSUPPORTED_SOURCES\b/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("src/ 내 SupportedSource 타입이 존재하지 않는다(런타임 SOURCE_IDS 관문으로 대체, ADR-006)", () => {
    const hits = listTsFiles(srcDir).filter((f) => /\bSupportedSource\b/.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("SC-001: 지원 소스 목록이 레지스트리에서 파생된다", () => {
  it("SOURCE_IDS 는 SOURCE_REGISTRY 의 key 목록과 정확히 일치한다", () => {
    expect([...SOURCE_IDS].sort()).toEqual(Object.keys(SOURCE_REGISTRY).sort());
  });

  it("lane-config.ts·diagnostics.ts 는 SOURCE_IDS(레지스트리 파생)를 import 해 사용한다", () => {
    const laneConfigSrc = fs.readFileSync(path.join(srcDir, "core/lane-config.ts"), "utf8");
    const diagnosticsSrc = fs.readFileSync(path.join(srcDir, "core/diagnostics.ts"), "utf8");
    expect(laneConfigSrc).toMatch(/SOURCE_IDS/);
    expect(diagnosticsSrc).toMatch(/SOURCE_IDS/);
    // 소비 지점이 src-adapters/index.js 에서 import 한다(레지스트리 파생 — 별개 하드코딩 아님).
    expect(laneConfigSrc).toMatch(/from ["']\.\.\/src-adapters\/index\.js["']/);
    expect(diagnosticsSrc).toMatch(/from ["']\.\.\/src-adapters\/index\.js["']/);
  });
});
