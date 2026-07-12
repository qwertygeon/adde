import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lanePaths } from "../../src/shared/paths.js";
import { getEntry, findUnsent } from "../../src/core/out-ledger.js";

// SC-013 (FR-012, DEC-001): 업그레이드 시점 레거시 out/ 마커(미전송 + 종단 혼재) 존재 상태에서 ledger
// 형식 프로세스가 기동 — 1회성 자동 마이그레이션이 레거시 마커를 ledger 로 흡수·구 마커 제거하고,
// 미전송 메시지는 전달 대상으로 남고 이미 전송/종단 메시지는 재전송·재통지되지 않는다.
//
// 마이그레이션은 실 OS 프로세스(워커) 기동 경로로 수행한다(PROC-R18 — in-process 함수 호출 갈음 금지).

const WORKER = fileURLToPath(new URL("../fixtures/out-ledger-crash-worker.mts", import.meta.url));

let tmpBase: string;
const PROJ = "migrateproj";
const LANE = "migrate-lane";

function runMigrateWorker(): Promise<{ migrated: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, tmpBase, PROJ, LANE, "migrate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { migrated: number });
    });
    child.on("error", reject);
  });
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-outledger-migrate-"));
  const paths = lanePaths(tmpBase, PROJ, LANE);
  fs.mkdirSync(paths.outDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("migrateLegacyOut — SC-013 레거시 마커 1회성 마이그레이션(실 프로세스 기동)", () => {
  it("미전송+종단 혼재 레거시 마커를 ledger 로 흡수하고 구 마커를 제거한다", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);

    // 레거시 픽스처: unsent(.out 만) · sent(.out+.sent) · aborted(.out+.aborted) · failed(.out 없음+.failed)
    fs.writeFileSync(path.join(paths.outDir, "unsent.out"), "미전송 응답");
    fs.writeFileSync(path.join(paths.outDir, "unsent.out.json"), JSON.stringify({ reply_ref: { channel_msg_id: "1" } }));

    fs.writeFileSync(path.join(paths.outDir, "sent.out"), "전송완료 응답");
    fs.writeFileSync(path.join(paths.outDir, "sent.out.json"), "{}");
    fs.writeFileSync(path.join(paths.outDir, "sent.sent"), "2026-06-01T00:00:00.000Z");

    fs.writeFileSync(path.join(paths.outDir, "aborted.out"), "불확실 종단 응답");
    fs.writeFileSync(path.join(paths.outDir, "aborted.aborted"), "2026-06-01T00:00:00.000Z");

    fs.writeFileSync(path.join(paths.outDir, "failed.failed"), "inject 실패 기록");

    const result = await runMigrateWorker();
    expect(result.migrated).toBeGreaterThanOrEqual(4);

    // 구 마커 전부 제거(body 는 보존).
    for (const legacy of [
      "unsent.out.json",
      "sent.sent",
      "sent.out.json",
      "aborted.aborted",
      "failed.failed",
    ]) {
      expect(fs.existsSync(path.join(paths.outDir, legacy))).toBe(false);
    }
    expect(fs.existsSync(path.join(paths.outDir, "unsent.out"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "sent.out"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "aborted.out"))).toBe(true);

    // 상태 흡수 정확성.
    expect((await getEntry(paths, "unsent"))?.state).toBe("done");
    expect((await getEntry(paths, "sent"))?.state).toBe("sent");
    expect((await getEntry(paths, "aborted"))?.state).toBe("aborted");
    expect((await getEntry(paths, "failed"))?.state).toBe("failed");

    // 미전송(unsent)만 재전달 대상으로 남고, 종단(sent/aborted)은 재통지·재전송 대상이 아니다.
    const unsent = await findUnsent(paths);
    expect(unsent).toContain("unsent");
    expect(unsent).not.toContain("sent");
    expect(unsent).not.toContain("aborted");
  });

  it("재기동(마이그레이션 재실행)은 no-op 으로 수렴한다(멱등, ledger.json 이미 존재)", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    fs.writeFileSync(path.join(paths.outDir, "x.out"), "resp");
    fs.writeFileSync(path.join(paths.outDir, "x.sent"), "2026-06-01T00:00:00.000Z");

    const r1 = await runMigrateWorker();
    expect(r1.migrated).toBeGreaterThanOrEqual(1);

    const r2 = await runMigrateWorker();
    expect(r2.migrated).toBe(0); // ledger.json 이미 존재 — 재마이그레이션 없음(1회성)
    expect((await getEntry(paths, "x"))?.state).toBe("sent"); // 상태 보존
  });
});
