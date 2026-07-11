import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { waitFor } from "../helpers/wait.js";

// followFile 코어(src/core/log-follow.ts) 실 fs 통합 검증 — SC-006·007(대표: append 라이브)·
// SC-008(세대 회전)·SC-009(truncate)·SC-010(abort 즉시 정지). transcript/engine 은 동일 메커니즘을
// 공유하므로(readLogs 대상만 다름) 파일 하나로 append/회전/truncate/abort 를 대표 검증한다.
// 모듈 미착지 시 개별 테스트 단위로 격리되도록 각 it 내부에서 동적 import 한다(PROC-R15).

let tmpDir: string;
let target: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-follow-"));
  target = path.join(tmpDir, "transcript.log");
  fs.writeFileSync(target, "line1\n");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("append 라이브 tail (SC-006·SC-007 대표)", () => {
  it("append 직후 신규 라인만 emit 된다(초기 스냅샷 재출력 없음)", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const startOffset = fs.statSync(target).size;
    const startIno = fs.statSync(target).ino;
    const done = followFile(target, {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 20,
      startOffset,
      startIno,
    });

    fs.appendFileSync(target, "line2\n");
    await waitFor(() => chunks.join("").includes("line2"), { timeoutMs: 2000 });

    ac.abort();
    await done;

    expect(chunks.join("")).toContain("line2");
    expect(chunks.join("")).not.toContain("line1");
  });
});

describe("세대 회전(rename) 추적 (SC-008)", () => {
  it("rename 회전 후 유실·중복 없이 신 활성 파일(신규 inode)의 라인을 이어서 출력한다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const startOffset = fs.statSync(target).size;
    const startIno = fs.statSync(target).ino;
    const done = followFile(target, {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 20,
      startOffset,
      startIno,
    });

    // 크기 기반 세대 회전과 동형: rename(current, current.1) 후 신 파일 생성(신규 inode).
    fs.renameSync(target, `${target}.1`);
    fs.writeFileSync(target, "gen2-a\n");
    await waitFor(() => chunks.join("").includes("gen2-a"), { timeoutMs: 2000 });

    fs.appendFileSync(target, "gen2-b\n");
    await waitFor(() => chunks.join("").includes("gen2-b"), { timeoutMs: 2000 });

    ac.abort();
    await done;

    const joined = chunks.join("");
    expect(joined).toContain("gen2-a");
    expect(joined).toContain("gen2-b");
    expect(joined.split("gen2-a").length - 1).toBe(1); // 중복 emit 없음
  });
});

describe("truncate(길이 축소) 추적 (SC-009)", () => {
  it("truncate 후 오프셋을 재조정해 중복·유실 없이 신규 라인만 출력한다", async () => {
    fs.appendFileSync(target, "before-trunc\n");
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const startOffset = fs.statSync(target).size;
    const startIno = fs.statSync(target).ino;
    const done = followFile(target, {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 20,
      startOffset,
      startIno,
    });

    fs.truncateSync(target, 0);
    fs.appendFileSync(target, "after-trunc\n");
    await waitFor(() => chunks.join("").includes("after-trunc"), { timeoutMs: 2000 });

    ac.abort();
    await done;

    const joined = chunks.join("");
    expect(joined).toContain("after-trunc");
    expect(joined).not.toContain("before-trunc");
  });
});

describe("SIGINT(abort) 즉시 정지 (SC-010)", () => {
  it("abort 시 유계 시간 내 resolve 하고(hang 없음) 이후 추가 emit 이 없다", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const startOffset = fs.statSync(target).size;
    const startIno = fs.statSync(target).ino;
    const done = followFile(target, {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 20,
      startOffset,
      startIno,
    });

    ac.abort();
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("followFile 이 abort 후에도 정지하지 않음(hang)")),
          1000,
        ),
      ),
    ]);

    const countAfterAbort = chunks.length;
    fs.appendFileSync(target, "post-abort\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(chunks.length).toBe(countAfterAbort); // abort 후 추가 폴링 없음
  });
});
