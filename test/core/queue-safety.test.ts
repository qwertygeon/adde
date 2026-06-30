import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// SC1: writeOut sidecar-first 순서(`.out` 존재 ⇒ sidecar 존재).
// SC2: claimNext ENOENT(정상)=null vs 비-ENOENT=전파.

// fs/promises 의 writeFile/rename 을 선택적으로 가로채는 훅(hoisted — vi.mock 팩토리에서 참조 가능).
const h = vi.hoisted(() => ({
  failOutBodyWrite: false,
  renameError: null as NodeJS.ErrnoException | null,
}));

vi.mock("node:fs/promises", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs/promises");
  return {
    ...actual,
    writeFile: async (p: unknown, data: unknown, opts?: unknown) => {
      // 본문 tmp(`.<id>.out.tmp`)만 가로챔 — sidecar tmp 는 `.out.json.tmp` 라 매칭 안 됨.
      if (h.failOutBodyWrite && typeof p === "string" && p.endsWith(".out.tmp")) {
        throw new Error("주입된 본문 쓰기 실패");
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(p, data, opts);
    },
    rename: async (s: unknown, d: unknown) => {
      if (h.renameError) throw h.renameError;
      return (actual.rename as (...a: unknown[]) => Promise<void>)(s, d);
    },
  };
});

const { writeOut, isDone, readSidecar, claimNext } = await import("../../src/core/queue.js");
import { lanePaths } from "../../src/shared/paths.js";

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-qsafe-"));
  paths = lanePaths(tmpBase, "p", "lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  h.failOutBodyWrite = false;
  h.renameError = null;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("writeOut sidecar-first 순서 (SC1)", () => {
  it("정상 경로: 본문·sidecar 둘 다 기록되고 done·reply_ref 보존", async () => {
    await writeOut(paths, "m1", "응답", { reply_ref: { channel_msg_id: "42" } });
    expect(await isDone(paths, "m1")).toBe(true);
    expect(fs.readFileSync(path.join(paths.outDir, "m1.out"), "utf8")).toBe("응답");
    const sc = await readSidecar(paths, "m1");
    expect(sc?.reply_ref?.channel_msg_id).toBe("42");
  });

  it("본문 쓰기 실패 시 sidecar 는 이미 디스크에 있고 `.out`(done 마커)은 없다", async () => {
    h.failOutBodyWrite = true;
    await expect(
      writeOut(paths, "m2", "응답", { reply_ref: { channel_msg_id: "7" } }),
    ).rejects.toThrow();
    // sidecar 먼저 확정 → 존재. 본문(done 마커)은 미생성 → 크래시해도 done 으로 오인되지 않음.
    expect(fs.existsSync(path.join(paths.outDir, "m2.out.json"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "m2.out"))).toBe(false);
  });
});

describe("claimNext 오류 구분 (SC2)", () => {
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
});
