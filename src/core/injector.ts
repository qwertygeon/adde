/**
 * 직렬 idle 게이트·dedup 루프.
 * FR-004/005/011/ADR-003: state=idle|active. active 동안 다음 envelope 미주입.
 * 크래시 재개: 기동 시 scanProcessing → 각 id 에 isDone? 스킵 : 재처리.
 */
import { claimNext, scanProcessing, isDone, writeOut } from "./queue.js";
import type { LanePaths } from "../shared/paths.js";
import type { AcpBackend } from "../backend/acp/client.js";

export type InjectorState = "idle" | "active";

export interface Injector {
  start(): Promise<void>;
  onIdle(): void;
  getState(): InjectorState;
}

export function createInjector(paths: LanePaths, lane: string, backend: AcpBackend): Injector {
  let state: InjectorState = "idle";

  async function injectNext(): Promise<void> {
    if (state !== "idle") return;

    const claimed = await claimNext(paths);
    if (!claimed) return;

    const { id, envelope } = claimed;

    if (await isDone(paths, id)) {
      // dedup: out 이미 존재 → prompt 미호출
      state = "idle";
      setImmediate(() => void injectNext());
      return;
    }

    state = "active";
    try {
      await backend.inject(lane, envelope.text);
    } catch (err) {
      console.error(
        `[injector] inject 오류 lane=${lane} id=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      state = "idle";
      setImmediate(() => void injectNext());
    }
  }

  async function start(): Promise<void> {
    // 크래시 재개: processing 잔존 파일 스캔
    const pendingIds = await scanProcessing(paths);
    for (const id of pendingIds) {
      const done = await isDone(paths, id);
      if (done) {
        // dedup — 이미 out 있음, 스킵
        continue;
      }
      // 재처리 대상: claimNext 와 동일 패턴으로 enqueue 복원하지 않고
      // processing 파일 자체를 그대로 두면 claimNext 가 다음에 처리하므로
      // 이 경우 직접 inject 한다.
      try {
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { parseEnvelope } = await import("../shared/envelope.js");
        const filePath = join(paths.processingDir, `${id}.msg`);
        const json = await readFile(filePath, "utf8");
        const envelope = parseEnvelope(json);
        state = "active";
        await backend.inject(lane, envelope.text);
      } catch (err) {
        console.error(
          `[injector] 재처리 오류 lane=${lane} id=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        state = "idle";
      }
    }

    state = "idle";
    await injectNext();
  }

  function onIdle(): void {
    state = "idle";
    setImmediate(() => void injectNext());
  }

  function getState(): InjectorState {
    return state;
  }

  return { start, onIdle, getState };
}

export { writeOut };
