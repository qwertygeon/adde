import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { AcpBackendImpl } from "../../src/backend/acp/client.js";
import { lanePaths } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

// SC-001 (FR-001): 핸드셰이크 이후 엔진 child 의 정상·비정상 종료를 레인별 종료 신호로 감지한다
// (spawn/kill 실패 'error' 신호와는 구분).
//
// 실프로세스(fake-acp-agent.mjs) 를 실제로 kill 해 Node child_process 의 'exit' 를 검증한다 —
// no-op 더블(가짜 EventEmitter) 로는 실제 프로세스 종료 시맨틱(exit vs error, signal 전달)을
// 재현하지 못하므로 실 child 로 검증한다(coding rule E3 / 확정 signature: AcpBackend.onExit?).

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

let tmpBase: string;
let backend: AcpBackendImpl;

/**
 * AcpBackendImpl 은 child 를 private Map(lanes)에 캡슐화한다 — 테스트는 실 child 에 직접 신호를
 * 보내기 위해 내부 상태에 리플렉션으로 접근한다(F11 test 의 mintPermId 접근과 동일 관례).
 */
function currentChild(impl: AcpBackendImpl, lane: string): ChildProcess {
  const lanes = (impl as unknown as { lanes: Map<string, { child: ChildProcess }> }).lanes;
  const state = lanes.get(lane);
  if (!state) throw new Error(`lane "${lane}" not launched`);
  return state.child;
}

beforeEach(() => {
  fs.chmodSync(FIXTURE, 0o755);
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-crash-detect-"));
  const paths = lanePaths(tmpBase, "p", "lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  backend = new AcpBackendImpl(FIXTURE);
  backend.configureLane("lane", { paths });
});

afterEach(async () => {
  await backend.close("lane").catch(() => {});
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("AcpBackend.onExit (SC-001 — 크래시 감지)", () => {
  it("핸드셰이크 완료 후 child 가 크래시(exit)하면 onExitHandler 가 1회 호출된다 (Happy)", async () => {
    await backend.launch("lane");
    const received: Array<{ lane: string; code: number | null; signal: NodeJS.Signals | null }> =
      [];
    backend.onExit!("lane", (lane, info) => received.push({ lane, ...info }));

    // 실프로세스 강제 종료 — 실제 'exit' 이벤트를 유발한다(mock emit 아님).
    currentChild(backend, "lane").kill("SIGKILL");

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0]?.lane).toBe("lane");
    expect(received[0]?.signal).toBe("SIGKILL");
  });

  it("spawn/kill 실패('error')는 onExitHandler 를 트리거하지 않는다 (Error)", async () => {
    await backend.launch("lane");
    const received: unknown[] = [];
    backend.onExit!("lane", (lane, info) => received.push({ lane, info }));

    // 핸드셰이크 후 'error' 는 spawn/kill 실패 전용(Node 공식 — 정상/비정상 종료엔 미발생).
    // 실 child(EventEmitter) 에 직접 발생시켜, 로거로 교체된 실제 리스너가 이를 크래시로
    // 오인하지 않는지 검증한다(client.ts:597 onSpawnError 전환 지점).
    currentChild(backend, "lane").emit("error", new Error("EPIPE (simulated)"));

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);

    // child 는 여전히 살아있다(실패 신호가 실제 종료를 유발하지 않았음을 별도로 확인).
    expect(currentChild(backend, "lane").exitCode).toBeNull();
  });

  it("launch 전 onExit 등록은 throw 하지 않는다(핸드셰이크 후 유효 계약 — 등록 자체는 무해)", () => {
    expect(() => backend.onExit!("nolane", () => {})).not.toThrow();
  });
});
