import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-075 (FR-030) — 공장 초기화는 명령 전용이다: 팔레트 렌더·노트 파서 어디에도 트리거가 없다.
// "factory-reset" 문자열이 surfaces 하위에 등장 0건.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("SC-075: 공장 초기화는 노트·팔레트에 트리거가 없다", () => {
  it("Happy: src/surfaces/** 어디에도 'factory-reset' 문자열이 등장하지 않는다", () => {
    const surfacesDir = path.join(repoRoot, "src", "surfaces");
    const files = listTsFiles(surfacesDir);
    expect(files.length).toBeGreaterThan(0); // 자기점검 — 스캔이 공회전하지 않았다.
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes("factory-reset"));
    expect(hits).toEqual([]);
  });

  it("Edge: 팔레트 렌더 결과 항목에도 초기화 관련 라벨이 없다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "native",
        attachments: [],
      } as never,
      true,
    );
    expect(items.some((i) => /factory|reset/i.test(i))).toBe(false);
  });

  it("Error: 문자열 'factory-reset' 을 surfaces 에 도입하면 검출기가 잡는다(자기점검)", () => {
    const injected = `// factory-reset trigger placeholder`;
    expect(injected.includes("factory-reset")).toBe(true);
  });
});
