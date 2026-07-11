import { describe, expect, it, vi } from "vitest";
import { waitFor } from "../helpers/wait.js";
import type { FollowDeps } from "../../src/core/log-follow.js";

// followFile 신 계약(fs.watch+안전망 하이브리드, read: Promise<Buffer>, watch 주입점) 단위 검증 —
// SC-102(read ENOENT 격리)·SC-103(멀티바이트 경계 이월)·SC-105(abort 후 잔여 tick 없음)·
// SC-106(truncate-후-재성장 오판 없음)·SC-113(watch 미발화 시 안전망 폴링 감지).
// 모듈 미착지 시 개별 테스트 단위로 격리되도록 각 it 내부에서 동적 import 한다(PROC-R15).

function fakeWatch(): NonNullable<FollowDeps["watch"]> {
  return vi.fn((_path: string, _listener: (eventType: string, filename: string | null) => void) => ({
    close: () => {},
  }));
}

describe("SC-102: stat 성공 후 read ENOENT 격리 — 크래시 없이 skip 후 회전 수렴", () => {
  it("read 실패 관측은 크래시 없이 건너뛰고, 다음 관측에서 회전 분기로 수렴해 방출한다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    let readCall = 0;
    const stat = vi.fn(async () => ({ ino: 2, size: 6 })); // startIno=1 대비 회전 감지, 이후 무변화
    const read = vi.fn(async (_p: string, _offset: number, _length: number) => {
      readCall++;
      if (readCall === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from("rotate\n");
    });
    const watch = fakeWatch();

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read, watch },
      startOffset: 999,
      startIno: 1,
    });

    await waitFor(() => chunks.join("").includes("rotate"), { timeoutMs: 1000 });
    ac.abort();
    await done;

    expect(chunks.join("")).toContain("rotate");
    expect(readCall).toBeGreaterThanOrEqual(2); // 최초 실패 후 재시도로 성공
  });
});

describe("SC-103: 멀티바이트 경계 분할 무손상", () => {
  it("한글 3바이트가 두 관측에 걸쳐 분할 도착해도 U+FFFD 없이 원문자로 방출된다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const full = Buffer.from("가", "utf8"); // [0xEA, 0xB0, 0x80]
    let stage = 0;
    const stat = vi.fn(async () => (stage === 0 ? { ino: 1, size: 1 } : { ino: 1, size: 3 }));
    const read = vi.fn(async (_p: string, offset: number, length: number) =>
      full.subarray(offset, offset + length),
    );
    const watch = fakeWatch();

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read, watch },
      startOffset: 0,
      startIno: 1,
    });

    await waitFor(() => stat.mock.calls.length >= 1, { timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 20)); // 1바이트 관측이 먼저 안정적으로 처리되도록
    stage = 1;
    await waitFor(() => chunks.join("").includes("가"), { timeoutMs: 1000 });

    ac.abort();
    await done;

    expect(chunks.join("")).not.toContain("�");
    expect(chunks.join("")).toBe("가");
  });
});

describe("SC-105: abort 후 잔여 tick 없음", () => {
  it("abort 시 새 observe 가 실행되지 않고 유계 시간 내 resolve 한다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const ac = new AbortController();
    let statCalls = 0;
    const stat = vi.fn(async () => {
      statCalls++;
      return { ino: 1, size: 0 };
    });
    const read = vi.fn(async () => Buffer.alloc(0));
    const watch = fakeWatch();

    const done = followFile("dummy-target", {
      onData: () => {},
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read, watch },
      startOffset: 0,
      startIno: 1,
    });

    await waitFor(() => statCalls >= 1, { timeoutMs: 1000 });
    ac.abort();
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("followFile 이 abort 후에도 정지하지 않음(hang)")), 1000),
      ),
    ]);

    const countAtAbort = statCalls;
    await new Promise((r) => setTimeout(r, 100));
    expect(statCalls).toBe(countAtAbort); // abort 후 추가 관측 없음
  });
});

describe("SC-106: truncate 후 재성장 오판 없음", () => {
  it("size<offset(truncate) 를 감지하면 offset 0 재조정 후 재성장분을 처음부터 방출한다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ ino: 1, size: 3 }) // size(3) < startOffset(100) → truncate
      .mockResolvedValue({ ino: 1, size: 3 });
    const read = vi.fn(async (_p: string, _offset: number, _length: number) =>
      Buffer.from("trunc\n"),
    );
    const watch = fakeWatch();

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read, watch },
      startOffset: 100,
      startIno: 1,
    });

    await waitFor(() => read.mock.calls.length >= 1, { timeoutMs: 1000 });
    ac.abort();
    await done;

    expect(read.mock.calls[0]?.[1]).toBe(0); // truncate 재조정 — 0 부터 재읽기
    expect(chunks.join("")).toContain("trunc");
  });
});

describe("SC-113: watch 미발화 시 폴링 안전망이 신규 라인을 감지·방출한다", () => {
  it("watch 가 이벤트를 발화하지 않아도 안전망 폴링(pollMs)이 append 를 감지해 방출한다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    let size = 0;
    const stat = vi.fn(async () => ({ ino: 1, size }));
    const content = "safety-net\n";
    const read = vi.fn(async (_p: string, offset: number, length: number) =>
      Buffer.from(content, "utf8").subarray(offset, offset + length),
    );
    // listener 를 저장만 하고 절대 호출하지 않는 fake — watch 이벤트 미발화를 모사한다.
    const watch = vi.fn((_dir: string, _listener: (e: string, f: string | null) => void) => ({
      close: () => {},
    }));

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 10,
      deps: { stat, read, watch },
      startOffset: 0,
      startIno: 1,
    });

    await new Promise((r) => setTimeout(r, 30)); // 무변화 관측 1~2회 안정화
    size = content.length; // append 발생 — watch 는 호출되지 않음(fake 가 listener 를 발화 안 함)

    await waitFor(() => chunks.join("").includes("safety-net"), { timeoutMs: 1000 });
    ac.abort();
    await done;

    expect(watch).toHaveBeenCalled(); // watch 는 수립됐으나
    expect(chunks.join("")).toContain("safety-net"); // 이벤트 없이도 안전망 폴링이 감지·방출
  });
});
