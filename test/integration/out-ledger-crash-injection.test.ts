import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lanePaths } from "../../src/shared/paths.js";
import { getEntry, findUnsent } from "../../src/core/out-ledger.js";
import { createInjector } from "../../src/core/injector.js";
import { enqueue } from "../../src/core/queue.js";
import { makeEnvelope } from "../helpers/envelope.js";
import { waitFor } from "../helpers/wait.js";

// SC-005 (FR-005): 전이 두 쓰기(body→ledger) 사이 크래시 → 재시작 시 전/후 상태만 관측(부분조합 없음).
// SC-006 (FR-006): telegram(비멱등) sending 후 sent 전 크래시 → 불확실 통지 1회 + aborted 종단.
// SC-014 (NFR-001): 각 전이 지점 크래시 주입 → out/+dedup 불변식 재전송0·유실0.
// SC-004 (FR-004): done 기록 + processing 잔존 크래시 재개 → 재주입 안 함(dedup).
//
// 워커(out-ledger-crash-worker.mts)를 실 OS 프로세스로 spawn 해 각 전이 지점에서 실제로 종료시켜
// 크래시창을 재현한다(PROC-R18 — 워커 내 함수 직접호출·타이머 모킹 갈음 금지). 회복 판정은 별도
// 프로세스 종료 후 실 fs 상태를 이 프로세스(부모)가 관측한다.

const WORKER = fileURLToPath(new URL("../fixtures/out-ledger-crash-worker.mts", import.meta.url));

let tmpBase: string;
const PROJ = "crashproj";
const LANE = "crash-lane";

function runWorker(mode: string, ...args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, tmpBase, PROJ, LANE, mode, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => reject(new Error(`${err.message}\n${stderr}`)));
  });
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-outledger-crash-"));
  const paths = lanePaths(tmpBase, PROJ, LANE);
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("SC-005: body→ledger 전이 사이 실 프로세스 크래시 — 부분조합 미관측", () => {
  it("body 만 확정된 채 크래시하면 재시작 시 ledger done entry 가 없다(전이 전 상태만 관측)", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await runWorker("body-then-crash", "mid1");

    // 실 프로세스가 setDone 도달 전 종료 — body 는 durable(실 fs), ledger 커밋은 없다(부분조합 미관측).
    expect(fs.existsSync(path.join(paths.outDir, "mid1.out"))).toBe(true);
    expect(await getEntry(paths, "mid1")).toBeUndefined();
  });

  it("body+ledger 모두 확정된 후 크래시하면 재시작 시 done 상태로 온전히 관측된다(전이 후 상태)", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await runWorker("done-then-crash", "mid2");

    expect(fs.existsSync(path.join(paths.outDir, "mid2.out"))).toBe(true);
    expect((await getEntry(paths, "mid2"))?.state).toBe("done");
  });
});

describe("SC-006: telegram(비멱등) sending 후 sent 전 실 프로세스 크래시 — 불확실 1회·무재전송", () => {
  it("state=sending 잔존 → 재시작한 injector 가 재전송 대신 불확실 통지 1회 + aborted 종단", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await runWorker("sending-then-crash", "tg1");
    expect((await getEntry(paths, "tg1"))?.state).toBe("sending");

    const render = (): Promise<void> => Promise.resolve();
    const uncertain: string[] = [];
    const onUncertain = async (id: string): Promise<void> => {
      uncertain.push(id);
    };
    const backend = {
      inject: async () => {},
      caps: () => ({}),
      launch: async () => {},
      subscribe: () => {},
      onPermissionRequest: () => {},
      close: async () => {},
    };
    const injector = createInjector(paths, LANE, backend as never, render, undefined, undefined, {
      idempotent: false,
      onUncertain,
    });
    await injector.start();
    await waitFor(() => uncertain.length > 0);

    expect(uncertain).toEqual(["tg1"]);
    expect((await getEntry(paths, "tg1"))?.state).toBe("aborted");
  });

  it("정상 종단(sent) 후 크래시한 id 는 재시작해도 재통지·재전송되지 않는다(대조군)", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await runWorker("sent-then-crash", "tg2");
    expect((await getEntry(paths, "tg2"))?.state).toBe("sent");

    const unsent = await findUnsent(paths);
    expect(unsent).not.toContain("tg2");
  });
});

describe("SC-014: 각 전이 지점 크래시 주입 — out/+dedup 불변식 재전송0·유실0", () => {
  it("전이 전(body only)·전이 후(done)·전송 중(sending)·전송 완료(sent) 각 지점 크래시 후에도 응답 유실·중복전송이 없다", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await runWorker("body-then-crash", "p1");
    await runWorker("done-then-crash", "p2");
    await runWorker("sending-then-crash", "p3");
    await runWorker("sent-then-crash", "p4");

    // 유실 0: 확정된 body 는 모두 디스크에 남는다(p1 은 ledger 미확정이라도 body 자체는 유실 아님).
    for (const id of ["p1", "p2", "p3", "p4"]) {
      expect(fs.existsSync(path.join(paths.outDir, `${id}.out`))).toBe(true);
    }
    // 중복(재전송) 0: 이미 종단(sent) 인 p4 는 findUnsent 대상이 아니다.
    expect(await findUnsent(paths)).not.toContain("p4");
    // p2(done, 미전송)는 재전송 대상으로 남아 유실되지 않는다(at-least-once 전달 보존).
    expect(await findUnsent(paths)).toContain("p2");
  });
});

describe("SC-004: done 기록 + processing 잔존 크래시 재개 — 재주입 안 함(dedup)", () => {
  it("실 프로세스로 done 확정된 id 의 processing 잔존분이 있어도 재시작 injector 가 엔진에 재주입하지 않는다", async () => {
    const paths = lanePaths(tmpBase, PROJ, LANE);
    await enqueue(paths, makeEnvelope("dd1"));
    fs.writeFileSync(path.join(paths.processingDir, "dd1.msg"), JSON.stringify(makeEnvelope("dd1")));
    await runWorker("done-then-crash", "dd1");

    const inject = async (): Promise<void> => {
      throw new Error("dedup 위반 — inject 가 호출되면 안 됨");
    };
    const backend = {
      inject,
      caps: () => ({}),
      launch: async () => {},
      subscribe: () => {},
      onPermissionRequest: () => {},
      close: async () => {},
    };
    const injector = createInjector(paths, LANE, backend as never);
    await expect(injector.start()).resolves.toBeUndefined();
  });
});
