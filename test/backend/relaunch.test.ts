import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { AcpBackendImpl } from "../../src/backend/acp/client.js";
import { lanePaths } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

// 세션 제어의 재기동 경로(reset/resumeSession)를 fake ndjson ACP 에이전트로 실경로 검증.
// fake 는 계약을 강제한다(초기화 전 요청 거부·미지 세션 load 오류) — no-op 더블 금지 규칙.

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;
let backend: AcpBackendImpl;

beforeEach(() => {
  fs.chmodSync(FIXTURE, 0o755);
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-relaunch-"));
  paths = lanePaths(tmpBase, "p", "lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  backend = new AcpBackendImpl(FIXTURE);
  backend.configureLane("lane", { paths }); // addePolicy 미지정 — perm-diff 조회 생략
});

afterEach(async () => {
  await backend.close("lane");
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("AcpBackendImpl reset/resumeSession (실 child 재기동)", () => {
  it("reset 은 새 세션을 발급하고 구독자를 승계한다(재기동 후에도 이벤트 수신)", async () => {
    const first = await backend.launch("lane");
    const seen: string[] = [];
    backend.subscribe("lane", (e) => {
      const c = e["content"] as { text?: string } | undefined;
      if (c?.text) seen.push(c.text);
    });

    const second = await backend.reset("lane");
    expect(second.sessionId).not.toBe(first.sessionId);

    // 승계 검증: 재기동된 child 에 prompt → fake 가 "pong" 청크를 알림 → 구독자 수신
    await backend.inject("lane", "ping");
    await waitFor(() => seen.includes("pong"));
  });

  it("resumeSession 은 알려진 세션이면 그 id 로 복귀(resumed=true)", async () => {
    await backend.launch("lane");
    const r = await backend.resumeSession("lane", "known-abc");
    expect(r).toEqual({ sessionId: "known-abc", resumed: true });
    // session.id 파일도 복귀 세션으로 갱신
    expect(fs.readFileSync(paths.sessionIdFile, "utf8")).toBe("known-abc");
  });

  it("resumeSession 은 미지의 세션이면 새 세션 폴백(resumed=false)", async () => {
    await backend.launch("lane");
    const r = await backend.resumeSession("lane", "missing-1");
    expect(r.resumed).toBe(false);
    expect(r.sessionId).not.toBe("missing-1");
    expect(r.sessionId.length).toBeGreaterThan(0);
  });

  it("launch(resumeSessionId) 단독 호출도 load 성공 시 해당 id 유지", async () => {
    const r = await backend.launch("lane", { resumeSessionId: "known-z" });
    expect(r).toMatchObject({ sessionId: "known-z", resumed: true });
  });
});
