import { makeEnvelope } from "../helpers/envelope.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  enqueue,
  claimNext,
  scanProcessing,
  isDone,
  writeOut,
  markSent,
  markSending,
  isSending,
  clearSending,
  markAborted,
  findUnsent,
} from "../../src/core/queue.js";
import { lanePaths } from "../../src/shared/paths.js";

// fake fs quirk 재현: atomic rename 중간상태·.sync-conflict 출현
// SC-002: atomic rename — tmp 파일이 queue/ 에 노출되지 않음
// SC-003: processing 잔존 파일 재처리
// SC-005: out 존재 시 dedup (isDone)

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-test-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("enqueue (SC-002 atomic rename 부분쓰기 미노출)", () => {
  it("enqueue 완료 후 queue 디렉토리에 .msg 파일이 존재한다", async () => {
    const env = makeEnvelope();
    await enqueue(paths, env);
    const files = fs.readdirSync(paths.queueDir);
    const msgFiles = files.filter((f) => f.endsWith(".msg"));
    expect(msgFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("tmp→rename: queue/ 에 tmp 확장자 파일이 남지 않는다 (부분쓰기 미노출)", async () => {
    // fake fs quirk 재현: atomic rename 중간상태에서 .tmp 파일이 절대 큐 디렉토리에 노출되지 않아야 함
    const env = makeEnvelope();
    // enqueue 완료 후 중간 tmp 파일 없어야 함
    await enqueue(paths, env);
    const files = fs.readdirSync(paths.queueDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp") || f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it(".sync-conflict 파일은 큐 처리에서 무시된다 (fake fs quirk)", async () => {
    // sync-conflict 파일이 있어도 claimNext 가 크래시하지 않아야 함
    const conflictPath = path.join(paths.queueDir, "some-file.sync-conflict");
    fs.writeFileSync(conflictPath, "conflict data");
    // claimNext 는 .msg 확장자만 처리하므로 충돌 파일 무시
    const result = await claimNext(paths);
    expect(result).toBeNull();
  });

  it("여러 envelope 을 순차적으로 enqueue 할 수 있다", async () => {
    await enqueue(paths, makeEnvelope("id-1"));
    await enqueue(paths, makeEnvelope("id-2"));
    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(files.length).toBe(2);
  });
});

describe("claimNext (SC-003 queue→processing 상태 전이)", () => {
  it("queue 에 파일이 있으면 processing 으로 이동하고 반환한다", async () => {
    const env = makeEnvelope("claim-001");
    await enqueue(paths, env);
    const result = await claimNext(paths);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("claim-001");
    // processing 에 파일이 존재해야 함
    const procFiles = fs.readdirSync(paths.processingDir);
    expect(procFiles.length).toBeGreaterThanOrEqual(1);
    // queue 에는 없어야 함
    const queueFiles = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(queueFiles).toHaveLength(0);
  });

  it("queue 가 비었으면 null 을 반환한다", async () => {
    const result = await claimNext(paths);
    expect(result).toBeNull();
  });
});

describe("scanProcessing (SC-003 크래시 재처리)", () => {
  it("processing 디렉토리의 id 목록을 반환한다", async () => {
    // 크래시 상황 시뮬레이션: processing 에 파일 직접 배치
    fs.writeFileSync(
      path.join(paths.processingDir, "crash-id.msg"),
      JSON.stringify(makeEnvelope("crash-id")),
    );
    const ids = await scanProcessing(paths);
    expect(ids).toContain("crash-id");
  });

  it("processing 가 비었으면 빈 배열을 반환한다", async () => {
    const ids = await scanProcessing(paths);
    expect(ids).toEqual([]);
  });
});

describe("isDone (SC-005 dedup)", () => {
  it("out/<id>.out 가 존재하면 true 를 반환한다", async () => {
    const id = "done-001";
    fs.writeFileSync(path.join(paths.outDir, `${id}.out`), "응답 텍스트");
    expect(await isDone(paths, id)).toBe(true);
  });

  it("out/<id>.out 가 없으면 false 를 반환한다", async () => {
    expect(await isDone(paths, "not-done")).toBe(false);
  });
});

describe("writeOut (SC-005 dedup + atomic)", () => {
  it("writeOut 후 out/<id>.out 파일이 존재한다", async () => {
    await writeOut(paths, "out-001", "응답 텍스트", { reply_ref: { channel_msg_id: "42" } });
    const outFile = path.join(paths.outDir, "out-001.out");
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, "utf8")).toBe("응답 텍스트");
  });

  it("writeOut 후 sidecar .out.json 파일이 존재한다", async () => {
    await writeOut(paths, "out-002", "텍스트", { reply_ref: { channel_msg_id: "99" } });
    const sidecar = path.join(paths.outDir, "out-002.out.json");
    expect(fs.existsSync(sidecar)).toBe(true);
  });

  it("writeOut 후 isDone 이 true 를 반환한다 (dedup 게이트)", async () => {
    await writeOut(paths, "out-003", "내용", { reply_ref: { channel_msg_id: "1" } });
    expect(await isDone(paths, "out-003")).toBe(true);
  });
});

describe("A3: .sending 저널 마커 + findUnsent 종단 제외", () => {
  it("markSending/isSending/clearSending 왕복", async () => {
    const id = "j-1";
    expect(await isSending(paths, id)).toBe(false);
    await markSending(paths, id);
    expect(await isSending(paths, id)).toBe(true);
    await clearSending(paths, id);
    expect(await isSending(paths, id)).toBe(false);
  });

  it("clearSending 은 부재 시 조용히 통과한다", async () => {
    await expect(clearSending(paths, "absent")).resolves.toBeUndefined();
  });

  it("findUnsent 는 .sent 와 .aborted 를 모두 종단으로 제외한다", async () => {
    // u: 미전송(.out 만), s: 전송완료(.sent), a: 불확실 종단(.aborted)
    for (const id of ["u", "s", "a"]) {
      fs.writeFileSync(path.join(paths.outDir, `${id}.out`), "resp");
      fs.writeFileSync(path.join(paths.outDir, `${id}.out.json`), "{}");
    }
    await markSent(paths, "s");
    await markAborted(paths, "a");

    const unsent = await findUnsent(paths);
    expect(unsent).toEqual(["u"]); // s(전달완료)·a(불확실 종단) 제외
  });

  it("markAborted 로 종단된 id 는 .out 이 남아도 findUnsent 대상이 아니다(반복 통지 방지)", async () => {
    fs.writeFileSync(path.join(paths.outDir, "x.out"), "resp");
    await markAborted(paths, "x");
    expect(await findUnsent(paths)).not.toContain("x");
  });
});
