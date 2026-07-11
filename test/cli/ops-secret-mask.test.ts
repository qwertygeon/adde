import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runLogs } from "../../src/cli/ops.js";
import { appendTranscript } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

// 시크릿 비노출 (NFR-002) — SC-025. transcript/engine 은 appendTranscript/spawn 이 write-time 으로
// maskSecrets 를 적용한다(plan §외부검증) — logs 스냅샷·follow 는 파일을 그대로 읽어 sink 할 뿐이므로
// 신규 노출 경로가 없음을 회귀로 확인한다.

const RAW_TOKEN = `123456789:${"A".repeat(40)}`; // BOT_TOKEN_PATTERN(\d{5,}:[A-Za-z0-9_-]{30,}) 매치

let tmpBase: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-ops-secret-mask-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("logs 스냅샷 — write-time 마스킹 유지(회귀) (SC-025)", () => {
  it("--json/-f 없이도 raw 토큰이 노출되지 않는다", async () => {
    const paths = lanePaths(tmpBase, "p", "l");
    await appendTranscript(paths, { type: "agent_message_chunk", content: `token=${RAW_TOKEN}` });
    const cap = captureStdout();
    await runLogs(["p", "l"]);
    cap.restore();
    expect(cap.out()).not.toContain(RAW_TOKEN);
    expect(cap.out()).toContain("***");
  });
});

describe("logs --follow — 파일 그대로 읽어 sink(신규 노출 경로 없음) (SC-025)", () => {
  it("follow 중 append 된 마스킹 라인도 raw 토큰 없이 emit 된다", async () => {
    const paths = lanePaths(tmpBase, "p", "l");
    await appendTranscript(paths, { type: "agent_message_chunk", content: "seed" });
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const startOffset = fs.statSync(paths.transcriptLog).size;
    const startIno = fs.statSync(paths.transcriptLog).ino;
    const done = followFile(paths.transcriptLog, {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 20,
      startOffset,
      startIno,
    });

    await appendTranscript(paths, {
      type: "agent_message_chunk",
      content: `token=${RAW_TOKEN}`,
    });
    await waitFor(() => chunks.join("").length > 0, { timeoutMs: 2000 });

    ac.abort();
    await done;

    expect(chunks.join("")).not.toContain(RAW_TOKEN);
    expect(chunks.join("")).toContain("***");
  });
});
