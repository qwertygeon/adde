import { makeEnvelope } from "../helpers/envelope.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// SC-005: 전이 두 쓰기(body→ledger) 사이 크래시 → 재시작 시 전/후 상태만 관측(부분조합 없음).
// SC-012: claimNext ENOENT(정상)=null vs 비-ENOENT=전파. 손상 격리 시 setFailed(state="failed").
// SC-003/SC-015: 전송 마커(setSent)·findUnsent 종단 제외.

// fs/promises 의 writeFile/rename 을 선택적으로 가로채는 훅(hoisted — vi.mock 팩토리에서 참조 가능).
const h = vi.hoisted(() => ({
  failLedgerWrite: false,
  renameError: null as NodeJS.ErrnoException | null,
}));

vi.mock("node:fs/promises", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs/promises");
  return {
    ...actual,
    writeFile: async (p: unknown, data: unknown, opts?: unknown) => {
      // ledger.json 의 tmp(`.ledger.json.<pid>.tmp`)만 가로챔 — body tmp(`.<id>.out.<pid>.tmp`)는
      // 별도 파일명 패턴이라 매칭 안 됨(body-first 순서: 본문은 항상 성공, ledger 커밋만 실패 재현).
      if (h.failLedgerWrite && typeof p === "string" && /\.ledger\.json\.\d+\.tmp$/.test(p)) {
        throw new Error("주입된 ledger 커밋 실패");
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(p, data, opts);
    },
    rename: async (s: unknown, d: unknown) => {
      if (h.renameError) throw h.renameError;
      return (actual.rename as (...a: unknown[]) => Promise<void>)(s, d);
    },
  };
});

const { writeOutBody, readOutBody, getEntry, setDone, setSent, findUnsent } = await import(
  "../../src/core/out-ledger.js"
);
const { claimNext, enqueue } = await import("../../src/core/queue.js");
import { lanePaths } from "../../src/shared/paths.js";

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-qsafe-"));
  paths = lanePaths(tmpBase, "p", "lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  h.failLedgerWrite = false;
  h.renameError = null;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("body-first 전이 순서 (SC-005)", () => {
  it("정상 경로: 본문·ledger 둘 다 기록되고 done·reply_ref 보존", async () => {
    await writeOutBody(paths, "m1", "응답");
    await setDone(paths, "m1", { reply_ref: { channel_msg_id: "42" } });

    expect(fs.readFileSync(path.join(paths.outDir, "m1.out"), "utf8")).toBe("응답");
    const entry = await getEntry(paths, "m1");
    expect(entry?.state).toBe("done");
    expect(entry?.reply_ref?.channel_msg_id).toBe("42");
    expect(await readOutBody(paths, "m1")).toBe("응답");
  });

  it("본문 쓰기는 성공했으나 ledger 커밋(setDone)이 실패하면 body 는 있고 done entry 는 없다(크래시해도 done 오인 없음)", async () => {
    await writeOutBody(paths, "m2", "응답");
    h.failLedgerWrite = true;
    await expect(
      setDone(paths, "m2", { reply_ref: { channel_msg_id: "7" } }),
    ).rejects.toThrow();

    // 본문(body-first)은 이미 확정 → 존재. ledger done entry(commit)는 실패 → 부재.
    // 재시작 시 리더는 "전이 전"(entry 없음) 상태만 관측하고 부분조합을 만나지 않는다.
    expect(fs.existsSync(path.join(paths.outDir, "m2.out"))).toBe(true);
    expect(await getEntry(paths, "m2")).toBeUndefined();
  });
});

describe("claimNext 오류 구분 (SC2, queue 도메인 불변)", () => {
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

  it("손상 메시지는 격리(.corrupt + ledger failed 상태)하고 다음 유효 메시지를 claim 한다 (FR-2·SC-012)", async () => {
    // 더 이른 ts → 먼저 시도됨. 손상.
    fs.writeFileSync(path.join(paths.queueDir, `1700000000000-bad.msg`), "{ not json");
    await enqueue(paths, makeEnvelope("good", "정상")); // 큰 ts → 뒤에 정렬

    const claimed = await claimNext(paths);
    expect(claimed?.id).toBe("good");
    expect(claimed?.envelope.text).toBe("정상");
    // 손상 메시지는 격리되어 재시도 대상에서 제외되고, 가시성은 ledger state="failed" 로 기록된다.
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg.corrupt"))).toBe(true);
    const badEntry = await getEntry(paths, "bad");
    expect(badEntry?.state).toBe("failed");
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg"))).toBe(false);
  });
});

describe("전송 마커 setSent/findUnsent (FR-1, SC-003·SC-015)", () => {
  it("out 있고 sent 상태 아니면 findUnsent 대상, setSent 후 제외", async () => {
    await writeOutBody(paths, "u1", "응답");
    await setDone(paths, "u1", {});
    expect((await getEntry(paths, "u1"))?.state).not.toBe("sent");
    expect(await findUnsent(paths)).toContain("u1");

    await setSent(paths, "u1");
    expect((await getEntry(paths, "u1"))?.state).toBe("sent");
    expect(await findUnsent(paths)).not.toContain("u1");
  });
});
