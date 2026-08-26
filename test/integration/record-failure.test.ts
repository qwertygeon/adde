import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// ENOSPC 시뮬레이션은 node:fs/promises 를 통째로 목(mock)해야 한다(ESM 네임스페이스 직접
// spyOn 은 read-only 바인딩이라 실패 — sync-provider-read-trigger.test.ts 선례와 동일 패턴).
const fsCtl = vi.hoisted(() => ({ enospcOnce: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (fsCtl.enospcOnce) {
        fsCtl.enospcOnce = false;
        const err = new Error("no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      return actual.appendFile(...args);
    },
  };
});

// SC-014 (FR-014, ADR-007) — 기록 실패가 턴 진행을 막는다(fail-closed).
//
// PPG-1 실측 갱신(2026-08-26): `SessionManager.admit(sid)` 는 EngineDriver 의 EngineSession 을
// **직접 반환**한다(실측 `src/core/session-manager.ts` — SessionManagerDeps 에 `record` 주입
// 지점이 없다). 즉 `engine.send()` 를 직접 호출하는 경로는 TurnRunner(claim→append→projectTurn→
// admit→send→append→turn_end)를 **거치지 않는다** — record 실패 주입은 TurnRunner 관통 경로가
// 아니라 record/events.ts 계층에서 직접 검증해야 실효성이 있다(fake-record-store 주입은 이
// 발견 이전 가정이라 무효화됨 — 본 파일을 record 계층 직접 검증으로 재작성). TurnRunner 가 실제로
// 이 실패를 세션 error 상태로 전파하는지는 TurnRunner 관통 통합(향후 T-D 보강 또는 EXECUTION)이
// 별도로 확인해야 한다 — 이 갭을 test-cases.md PPG-1 동기화 표에 병기했다.

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-014: 기록 실패가 턴 진행을 막는다(record 계층 fail-closed)", () => {
  it("Happy: 저장소(이벤트 디렉터리) 쓰기 불가 상태에서 appendEvent 가 throw 한다(턴 진행 차단의 1차 근거)", async () => {
    const pathsMod = await import("../../src/shared/paths.js");
    const events = await import("../../src/record/events.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, SID);
    fs.mkdirSync(vp.eventsDir, { recursive: true });
    fs.chmodSync(vp.eventsDir, 0o500);
    try {
      await expect(
        events.appendEvent(
          makeRecordCtx(roots, PROJ, SID) as never,
          {
            v: 1,
            sid: SID,
            turn: 1,
            seq: 0,
            ts: new Date().toISOString(),
            t: "turn_start",
            envelopeId: "env-0",
            input: { text: "지시" },
          } as never,
        ),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(vp.eventsDir, 0o700);
    }
  });

  it("Edge: 턴 중간(도구 결과 append)에서도 동일하게 실패가 전파된다", async () => {
    const pathsMod = await import("../../src/shared/paths.js");
    const events = await import("../../src/record/events.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, SID);
    fs.mkdirSync(vp.eventsDir, { recursive: true });
    fs.chmodSync(vp.eventsDir, 0o500);
    try {
      await expect(
        events.appendEvent(
          makeRecordCtx(roots, PROJ, SID) as never,
          {
            v: 1,
            sid: SID,
            turn: 1,
            seq: 1,
            ts: new Date().toISOString(),
            t: "tool_result",
            id: "tool-1",
            output: "결과",
          } as never,
        ),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(vp.eventsDir, 0o700);
    }
  });

  it("Error: 디스크 가득(ENOSPC)류 오류도 동일하게 전파된다(fail-open 흡수 없음)", async () => {
    fsCtl.enospcOnce = true;
    const events = await import("../../src/record/events.js");
    await expect(
      events.appendEvent(
        makeRecordCtx(roots, PROJ, SID) as never,
        {
          v: 1,
          sid: SID,
          turn: 1,
          seq: 0,
          ts: new Date().toISOString(),
          t: "turn_start",
          envelopeId: "env-1",
          input: { text: "x" },
        } as never,
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });
  });
});
