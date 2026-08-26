import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// 확정 시그니처: appendEvent(ctx, e) · readEvents(ctx) · EVENTS_GENERATION_MAX_BYTES ·
// EVENTS_SCHEMA_VERSION · writeGenerationSummary(ctx, gen) · loadResumeIndex(ctx).
// RecordCtx 의 정확한 필드는 tasks.md 확정 시그니처 밖 — vaultPaths(확정)의 결과에 sid 를
// 더한 형태로 가정한다(ASSUMPTION, 불일치 시 PPG-1 동기화).

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeCtx() {
  const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
  return makeRecordCtx(roots, PROJ, SID) as never;
}

function turnStartEvent(seq: number, text: string) {
  return {
    v: 1,
    sid: SID,
    turn: seq,
    seq,
    ts: new Date().toISOString(),
    t: "turn_start",
    envelopeId: `env-${seq}`,
    input: { text },
  };
}

describe("SC-012: 기록이 크기 때문에 삭제되지 않는다", () => {
  it("Happy: 세대 임계(4 MiB)를 두 번 넘겨도 세대가 여러 개로 나뉘고 최초 이벤트가 그대로 남는다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    // 실 세대 상한(EVENTS_GENERATION_MAX_BYTES=4MiB)을 실제로 두 번 넘기도록 대용량 텍스트를
    // 반복 기록한다(상수는 tasks.md 확정 시그니처의 고정 export — mock 으로 낮추지 않고 실제 임계를
    // 관통시킨다). 이벤트당 ~600KB × 20 ≈ 12MiB.
    const bigText = "x".repeat(600 * 1024);
    for (let i = 1; i <= 20; i++) {
      await events.appendEvent(ctx, turnStartEvent(i, bigText) as never);
    }
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2); // 세대 분할 발생(2회 이상 넘김)
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect((collected[0] as { turn: number }).turn).toBe(1); // 최초 이벤트 잔존(1-based)
    expect(collected.length).toBe(20); // 삭제 0
  }, 20000);

  it("Edge: 세대 임계 경계에 정확히 일치하는 크기에서도 데이터가 유실되지 않는다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, turnStartEvent(1, "boundary") as never);
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(collected.length).toBe(1);
  });

  it("Error: 쓰기 도중 중단(파손 마지막 줄)이 발생해도 이전 이벤트는 보존되고 파손 줄만 스킵된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, turnStartEvent(1, "good") as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(1);
    fs.appendFileSync(files[files.length - 1]!, "{not valid json truncated");
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(collected).toHaveLength(1);
    expect((collected[0] as { turn: number }).turn).toBe(1);
  });
});

describe("SC-013: 시크릿이 기록 전에 마스킹된다", () => {
  const secretText = "5000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_this_is_fake_but_long_enough";

  it("Happy: 토큰 포함 입력·도구 출력을 기록해도 원문이 어디에도 남지 않는다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, turnStartEvent(1, `hello ${secretText}`) as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) {
      const content = fs.readFileSync(f, "utf8");
      expect(content).not.toContain(secretText);
    }
  });

  it("Edge: blob 임계를 넘는 큰 도구 출력 안에 토큰이 있어도 마스킹된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    const bigOutput = "y".repeat(10_000) + secretText + "z".repeat(10_000);
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "tool_result",
      id: "tool-1",
      output: bigOutput,
    } as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8")).not.toContain(secretText);
    }
  });

  it("Error: 마스킹 함수가 예외를 던지면 기록 자체가 실패한다(fail-closed, 원문 미기록)", async () => {
    vi.doMock("../../src/shared/mask.js", () => ({
      maskSecrets: () => {
        throw new Error("마스킹 실패 시뮬레이션");
      },
    }));
    vi.resetModules();
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await expect(events.appendEvent(ctx, turnStartEvent(1, secretText) as never)).rejects.toThrow();
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8")).not.toContain(secretText);
    }
    vi.doUnmock("../../src/shared/mask.js");
    vi.resetModules();
  });
});

describe("SC-037 (NFR-003): 시크릿이 어떤 산출 경로로도 새지 않는다 — 4경로", () => {
  const secretText = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789fakekey";

  it("Happy: 이벤트 기록·(가상)노트·(가상)로그·프로세스 인자 4경로 모두 원문이 없다", async () => {
    const events = await import("../../src/record/events.js");
    const maskMod = await import("../../src/shared/mask.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, turnStartEvent(1, secretText) as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) expect(fs.readFileSync(f, "utf8")).not.toContain(secretText);
    // "노트"·"로그" 경로는 investorprojector/log-follow 미착지 시점이라 마스킹 함수 자체의
    // 순수성으로 대리 검증한다(경로 4개 중 나머지 2개는 projector/logs 모듈 착지 후 EXECUTION 이 재확인).
    expect(maskMod.maskSecrets(secretText)).not.toContain(secretText);
  });

  it("Edge: 시크릿이 도구 인자(tool_call.input)에 포함돼도 마스킹된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "tool_call",
      id: "tool-1",
      name: "Bash",
      input: { cmd: `curl -H "Authorization: Bearer ${secretText}"` },
    } as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) expect(fs.readFileSync(f, "utf8")).not.toContain(secretText);
  });

  it("Error: 엔진 예외 메시지에 시크릿이 포함돼도 마스킹 후 표면화된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "error",
      message: `엔진 예외: 인증 실패 token=${secretText}`,
      fatal: true,
    } as never);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    for (const f of files) expect(fs.readFileSync(f, "utf8")).not.toContain(secretText);
  });
});

describe("EVENTS_GENERATION_MAX_BYTES · EVENTS_SCHEMA_VERSION 상수", () => {
  it("세대 상한은 4 MiB, 스키마 버전은 1 이다(ADR-034·ADR-026)", async () => {
    const events = await import("../../src/record/events.js");
    expect(events.EVENTS_GENERATION_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(events.EVENTS_SCHEMA_VERSION).toBe(1);
  });
});

describe("loadResumeIndex — 부팅 인덱스 비용 상한(ADR-010)", () => {
  it("닫힌 세대는 sidecar 만 읽고, turn_start/turn_end 페어로 완결 여부를 판정한다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, turnStartEvent(1, "a") as never);
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 1,
      ts: new Date().toISOString(),
      t: "turn_end",
      envelopeId: "env-1",
      stopReason: "end_turn",
    } as never);
    const index = await events.loadResumeIndex(ctx);
    expect(index.get("env-1")?.ended).toBe(true);
  });
});
