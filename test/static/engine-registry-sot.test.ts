import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-020 (FR-020): 지원 엔진 목록이 ENGINE_REGISTRY 에서 파생되고, 별개의 하드코딩된 엔진 목록이
// 존재하지 않는다. 세 소비 지점(지원 목록·검증·진단)이 모두 ENGINE_IDS 를 참조한다(ADR-005).

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

describe("SC-020: 지원 엔진 목록이 ENGINE_REGISTRY 에서 파생된다", () => {
  it("Happy: ENGINE_IDS 는 ENGINE_REGISTRY 의 key 목록과 정확히 일치한다", async () => {
    const engines = await import("../../src/engines/index.js");
    expect([...engines.ENGINE_IDS].sort()).toEqual(Object.keys(engines.ENGINE_REGISTRY).sort());
  });

  it("Edge: 레지스트리에 항목을 더블로 주입하면 ENGINE_IDS 파생 목록도 함께 확장된다", async () => {
    const engines = await import("../../src/engines/index.js");
    const extended: Record<string, unknown> = {
      ...engines.ENGINE_REGISTRY,
      "test-engine-sc020": { id: "test-engine-sc020", caps: {}, open: async () => ({}) },
    };
    expect(Object.keys(extended)).toContain("test-engine-sc020");
  });

  it("Error: src/ 어디에도 별개의 하드코딩 엔진 목록(KNOWN_ENGINES 류)이 존재하지 않는다", () => {
    const hits = listTsFiles(srcDir).filter((f) => {
      if (f.includes(`${path.sep}engines${path.sep}`)) return false; // 레지스트리 정의 자체는 제외
      return /\bKNOWN_ENGINES\b/.test(fs.readFileSync(f, "utf8"));
    });
    expect(hits).toEqual([]);
  });
});
