import { makeEnvelope } from "../helpers/envelope.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// T-D11 재작업(2026-08-26) — `core/out-ledger.ts` 는 폐기 대상(events.jsonl 파생으로 대체, ADR-010)
// 이라 body-first 전이·전송 마커(setSent/findUnsent) 관련 describe 는 제거했다(v2 대응은
// record/events.test.ts·record/dedup.test.ts·record/blobs.test.ts 가 담당). `claimNext` 의
// ENOENT/비-ENOENT 오류 구분과 손상 메시지 격리는 `core/queue.ts` 자체 계약(유지 대상)이라
// sessionPaths 로 교체해 보존한다.

const h = vi.hoisted(() => ({
  renameError: null as NodeJS.ErrnoException | null,
}));

vi.mock("node:fs/promises", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs/promises");
  return {
    ...actual,
    rename: async (s: unknown, d: unknown) => {
      if (h.renameError) throw h.renameError;
      return (actual.rename as (...a: unknown[]) => Promise<void>)(s, d);
    },
  };
});

const { claimNext, enqueue } = await import("../../src/core/queue.js");
import { sessionPaths } from "../../src/shared/paths.js";

let tmpBase: string;
let paths: ReturnType<typeof sessionPaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-qsafe-"));
  paths = sessionPaths(tmpBase, "p", "sess-1");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  h.renameError = null;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("claimNext 오류 구분 (queue 도메인 불변)", () => {
  function putQueueFile(id: string): void {
    fs.writeFileSync(path.join(paths.queueDir, `1700000000000-${id}.msg`), "{}");
  }

  it("ENOENT(경합 선점/파일 소멸)은 null 로 정상 처리하고 흡수하지 않는다", async () => {
    putQueueFile("a");
    h.renameError = Object.assign(new Error("사라짐"), { code: "ENOENT" });
    expect(await claimNext(paths)).toBeNull();
  });

  it("비-ENOENT(EBUSY 등) FS 오류는 전파하고 메시지는 큐에 남는다", async () => {
    putQueueFile("b");
    h.renameError = Object.assign(new Error("바쁨"), { code: "EBUSY" });
    await expect(claimNext(paths)).rejects.toMatchObject({ code: "EBUSY" });
    // rename 실패 → 파일은 큐에 잔존(손실 없음).
    const remaining = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(remaining).toHaveLength(1);
  });

  it("빈 큐는 null", async () => {
    expect(await claimNext(paths)).toBeNull();
  });

  it("손상 메시지는 격리(.corrupt)하고 다음 유효 메시지를 claim 한다", async () => {
    // 더 이른 ts → 먼저 시도됨. 손상.
    fs.writeFileSync(path.join(paths.queueDir, `1700000000000-bad.msg`), "{ not json");
    await enqueue(paths, makeEnvelope("good", "정상")); // 큰 ts → 뒤에 정렬

    const claimed = await claimNext(paths);
    expect(claimed?.id).toBe("good");
    expect(claimed?.envelope.text).toBe("정상");
    // 손상 메시지는 격리되어 재시도 대상에서 제외된다(가시성은 record/events.ts 의 error 이벤트가
    // 대체 — out-ledger state="failed" 는 폐기 대상이라 더 이상 근거로 쓰지 않는다).
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg.corrupt"))).toBe(true);
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg"))).toBe(false);
  });
});
