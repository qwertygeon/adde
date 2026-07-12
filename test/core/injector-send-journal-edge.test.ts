import { waitFor } from "../helpers/wait.js";
import { makeEnvelope } from "../helpers/envelope.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lanePaths } from "../../src/shared/paths.js";
// vi.mock 은 vitest 가 이 import 들 위로 호이스팅하므로, 아래 정적 import 는 모킹된 out-ledger 를 받는다.
// enqueue 는 queue.js 의 실제 구현(모킹 대상 아님).
import { enqueue } from "../../src/core/queue.js";
import { createInjector } from "../../src/core/injector.js";
import type { Injector } from "../../src/core/injector.js";

// setSent 를 "render 성공 직후 1회만 throw" 하도록 제어(디스크풀 등 ledger 커밋 실패 모사).
// vi.hoisted 로 토글을 끌어올려 호이스팅된 vi.mock 팩토리가 TDZ 없이 참조한다(typescript.md vi.mock 함정).
const ctl = vi.hoisted(() => ({ failSetSentOnce: false }));

vi.mock("../../src/core/out-ledger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/out-ledger.js")>();
  return {
    ...actual,
    setSent: vi.fn(async (paths: ReturnType<typeof lanePaths>, id: string) => {
      if (ctl.failSetSentOnce) {
        ctl.failSetSentOnce = false;
        throw new Error("sent-commit write boom (simulated ENOSPC)");
      }
      return actual.setSent(paths, id);
    }),
  };
});

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

/** ledger.json 동기 읽기 — waitFor 의 동기 조건함수에서 상태 폴링용(entry 부재 시 undefined). */
function ledgerEntry(id: string): { state?: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.outLedgerFile, "utf8")) as {
      entries: Record<string, { state?: string }>;
    };
    return raw.entries[id];
  } catch {
    return undefined;
  }
}

function makeBackend(inject = vi.fn().mockResolvedValue(undefined)) {
  return {
    inject,
    caps: vi.fn(),
    launch: vi.fn(),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-injector-edge-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  ctl.failSetSentOnce = false;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("A3 edge: render 성공 후 setSent throw → state=sending 잔존(프로세스 내) → 다음 flush 불확실 종단 (SC-007)", () => {
  it("render 는 1회만(재전송 없음), 같은 프로세스 다음 flush 가 불확실 통지 + state=aborted 종단(안전방향)", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      { idempotent: false, onUncertain },
    );

    ctl.failSetSentOnce = true; // render 직후 첫 setSent 를 실패시켜 state=sending 이 정리되지 않게 한다
    await enqueue(paths, makeEnvelope("edge1", "응답"));
    await injector.start();

    // render 성공 → setSent throw 로 state=sending 잔존 → scheduleNext 발 flush 가 불확실 처리.
    await waitFor(() => ledgerEntry("edge1")?.state === "aborted");

    expect(render).toHaveBeenCalledTimes(1); // 재전송(재render) 없음 = 중복 전송 없음
    expect(onUncertain).toHaveBeenCalledWith("edge1"); // 전달 불확실 1회 통지
    expect(ledgerEntry("edge1")?.state).toBe("aborted"); // 종단 처리(재통지·재전송 없음)
    errSpy.mockRestore();
  });
});
