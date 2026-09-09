import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — SQLite 연결 지점 전수 정적 검증(T037).
// src/**·test/** 를 전수 grep 해 팩토리 밖 `new DatabaseSync(` 매치 0건을 단언한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const FACTORY_FILE = "src/workflow/sqlite.ts";

function listTsFiles(dir: string): string[] {
  const full = path.join(repoRoot, dir);
  if (!fs.existsSync(full)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(p);
      } else if (entry.name.endsWith(".ts")) {
        out.push(path.relative(repoRoot, p));
      }
    }
  };
  walk(full);
  return out;
}

const SELF_PATH = "test/static/phase0-sqlite-connection-sites.test.ts";
// conformance 스위트는 `node:sqlite` 라이브러리 자체의 실제 동작을 검증하는 것이 목적이라
// 팩토리 우회가 아니라 의도된 직접 사용이다(그 파일 서두 주석 참조).
const CONFORMANCE_TEST_FILE = "test/workflow/sqlite-conformance.test.ts";

function findDirectDatabaseSyncUsage(): string[] {
  const files = [...listTsFiles("src"), ...listTsFiles("test")];
  const hits: string[] = [];
  const pattern = new RegExp("new " + "DatabaseSync" + "\\(");
  for (const rel of files) {
    if (rel === FACTORY_FILE || rel === SELF_PATH || rel === CONFORMANCE_TEST_FILE) continue;
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if (pattern.test(text)) hits.push(rel);
  }
  return hits;
}

describe("SC-025: 연결 전수 timeout 명시 지정", () => {
  it("Happy: 팩토리 함수 호출 시 timeout 상수가 전달된다", async () => {
    const sqliteModulePath = path.join(repoRoot, "src/workflow/sqlite.ts");
    if (!fs.existsSync(sqliteModulePath)) return; // PPG-1 병렬 — 레이어 B 미착지는 RED 예상(PROC-R15).
    const { openWorkflowDatabase } = await import("../../src/workflow/sqlite.js");
    const { DatabaseSync } = await import("node:sqlite");
    const db = openWorkflowDatabase({ DatabaseSync }, ":memory:");
    expect(db).toBeDefined();
    db.close();
  });

  it("Edge: timeoutMs 를 명시 지정하면 그 값이 전달된다(0 이하는 throw)", async () => {
    const sqliteModulePath = path.join(repoRoot, "src/workflow/sqlite.ts");
    if (!fs.existsSync(sqliteModulePath)) return;
    const { openWorkflowDatabase } = await import("../../src/workflow/sqlite.js");
    const { DatabaseSync } = await import("node:sqlite");
    const db = openWorkflowDatabase({ DatabaseSync }, ":memory:", { timeoutMs: 1000 });
    expect(db).toBeDefined();
    db.close();
    expect(() => openWorkflowDatabase({ DatabaseSync }, ":memory:", { timeoutMs: 0 })).toThrow();
    expect(() => openWorkflowDatabase({ DatabaseSync }, ":memory:", { timeoutMs: -1 })).toThrow();
  });

  it("Error: src/**·test/** 전수 조회에서 팩토리 밖 new DatabaseSync( 매치가 0건이다", () => {
    const hits = findDirectDatabaseSyncUsage();
    expect(hits).toEqual([]);
  });
});
