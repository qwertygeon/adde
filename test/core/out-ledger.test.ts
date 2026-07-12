import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readOutLedger,
  setDone,
  getEntry,
  findUnsent,
  writeOutBody,
  readOutBody,
  pruneOut,
  migrateLegacyOut,
} from "../../src/core/out-ledger.js";
import type { OutEntry } from "../../src/core/out-ledger.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { LanePaths } from "../../src/shared/paths.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// readOutLedger/setDone/setSending/setSent/setAborted/setFailed/getEntry/isDone/hasId/
// findUnsent/readSidecar/writeOutBody/readOutBody/pruneOut/migrateLegacyOut

let tmpBase: string;
let paths: LanePaths;

const NOW = new Date("2026-07-12T00:00:00.000Z");

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-outledger-"));
  paths = lanePaths(tmpBase, "myproj", "L");
  fs.mkdirSync(paths.outDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** ledger.json 픽스처를 직접 기록 — prune 나이 판정을 entry.ts 로 정밀 제어하기 위함. */
function writeLedgerFixture(entries: Record<string, OutEntry>): void {
  fs.mkdirSync(path.dirname(paths.outLedgerFile), { recursive: true });
  fs.writeFileSync(paths.outLedgerFile, JSON.stringify({ v: 1, entries }));
}

/** 레거시 마커 접미사 잔존 여부 — ledger 모델에서 하나도 생성되지 않아야 한다. */
function markerFilesExist(): string[] {
  if (!fs.existsSync(paths.outDir)) return [];
  return fs
    .readdirSync(paths.outDir)
    .filter((f) => [".out.json", ".sent", ".sending", ".aborted", ".failed"].some((ext) => f.endsWith(ext)));
}

/** 소스 텍스트에서 `export function <name>` 선언부터 다음 최상위 함수 선언 전까지를 추출
 * (중첩 함수 없는 본 파일 관례 전제 — AST 파싱 없이 SC-018 정적 검사 용도, research §F 정합). */
function extractFunctionBody(src: string, fnName: string): string {
  const re = new RegExp(`export (?:async )?function ${fnName}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return "";
  const rest = src.slice(m.index);
  const nextFn = rest.slice(1).search(/\nexport (?:async )?function /);
  return nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
}

describe("readOutLedger/setDone — SC-001 단일 구조화 레코드 + 마커파일 미생성", () => {
  it("여러 메시지 처리 후 ledger 1파일에 id 당 1 entry, 마커파일 미생성", async () => {
    await setDone(paths, "m1", { reply_ref: { channel_msg_id: "1" } });
    await setDone(paths, "m2", { reply_ref: { channel_msg_id: "2" } });

    const ledger = await readOutLedger(paths);
    expect(Object.keys(ledger.entries).sort()).toEqual(["m1", "m2"]);
    expect(ledger.entries["m1"]?.state).toBe("done");
    expect(ledger.entries["m1"]?.reply_ref?.channel_msg_id).toBe("1");
    expect(fs.existsSync(paths.outLedgerFile)).toBe(true);
    expect(markerFilesExist()).toEqual([]);
  });
});

describe("writeOutBody/setDone — SC-002 body 분리, ledger 비중복 저장", () => {
  it("body 는 <id>.out 파일로 유지되고 ledger entry 에는 텍스트가 중복 저장되지 않는다", async () => {
    await writeOutBody(paths, "b1", "응답 텍스트");
    await setDone(paths, "b1", { reply_ref: { channel_msg_id: "9" } });

    expect(fs.readFileSync(path.join(paths.outDir, "b1.out"), "utf8")).toBe("응답 텍스트");
    const entry = await getEntry(paths, "b1");
    expect(entry).toBeDefined();
    expect((entry as unknown as Record<string, unknown>)["text"]).toBeUndefined();
    expect(await readOutBody(paths, "b1")).toBe("응답 텍스트");
  });
});

describe("TERMINAL_STATES 단일 종단 정의 — SC-003", () => {
  it("findUnsent 와 pruneOut 이 동일한 종단 정의를 소비한다(종단 재도출 없음)", async () => {
    const oldIso = "2026-06-01T00:00:00.000Z"; // safeWindowDays=5 기준 경과
    writeLedgerFixture({
      unsent: { state: "done", ts: oldIso },
      sending: { state: "sending", ts: oldIso },
      sent: { state: "sent", ts: oldIso },
      aborted: { state: "aborted", ts: oldIso },
      failed: { state: "failed", ts: oldIso, reason: "boom" },
    });

    const unsent = await findUnsent(paths);
    expect(unsent.sort()).toEqual(["sending", "unsent"]);

    const { removed } = await pruneOut(paths, 5, NOW);
    // TERMINAL_STATES={sent,aborted} 만 원자 삭제 대상 — findUnsent 제외셋과 동일 정의 소비.
    expect(removed.sort()).toEqual(["aborted", "sent"]);

    const after = await readOutLedger(paths);
    expect(Object.keys(after.entries).sort()).toEqual(["failed", "sending", "unsent"]);
  });
});

describe("pruneOut — SC-010 안전창 경과 종단만 원자 삭제·미전송/진행중/failed 보존·no-op 수렴", () => {
  it("안전창 경과 종단(sent)만 body 포함 원자 삭제되고 미경과분·미전송·sending·failed 는 보존된다", async () => {
    const oldIso = "2026-06-01T00:00:00.000Z";
    const recentIso = "2026-07-11T12:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old-done.out"), "응답");
    writeLedgerFixture({
      "old-done": { state: "sent", ts: oldIso },
      "recent-done": { state: "sent", ts: recentIso },
      inflight: { state: "sending", ts: oldIso },
      unsent: { state: "done", ts: oldIso },
      failed: { state: "failed", ts: oldIso, reason: "x" },
    });

    const result = await pruneOut(paths, 5, NOW);

    expect(result.removed).toEqual(["old-done"]);
    expect(fs.existsSync(path.join(paths.outDir, "old-done.out"))).toBe(false); // body 도 함께 정리(원자 그룹)
    const after = await readOutLedger(paths);
    expect(after.entries["old-done"]).toBeUndefined();
    expect(after.entries["recent-done"]).toBeDefined();
    expect(after.entries["inflight"]).toBeDefined(); // .sending 은 안전창 경과여도 절대 제외
    expect(after.entries["unsent"]).toBeDefined();
    expect(after.entries["failed"]).toBeDefined(); // .failed 는 종단이 아니다(PR #44 quirk 보존)
  });

  it("재실행은 오류 없이 no-op 으로 수렴한다(멱등)", async () => {
    writeLedgerFixture({ old: { state: "sent", ts: "2026-06-01T00:00:00.000Z" } });
    const r1 = await pruneOut(paths, 5, NOW);
    expect(r1.removed).toEqual(["old"]);
    const r2 = await pruneOut(paths, 5, NOW);
    expect(r2.removed).toEqual([]);
  });

  it("ledger entries 가 없으면 no-op(removed 빈 배열)", async () => {
    const result = await pruneOut(paths, 5, NOW);
    expect(result.removed).toEqual([]);
  });
});

describe("pruneOut — SC-011 out_retention_days 기본 off → 무삭제", () => {
  it("pruneOut 을 호출하지 않으면(옵트인 미활성) 종단 엔트리가 그대로 유지된다", async () => {
    const oldIso = "2026-01-01T00:00:00.000Z";
    writeLedgerFixture({ old: { state: "sent", ts: oldIso } });
    // 옵트인(out_retention_days) 미설정 시 호출자가 pruneOut 을 호출하지 않는다 — 순수 함수 자체엔
    // 자동 트리거가 없음을 확인(호출 전까지 무변화, C-02 호출자 책임과 분리).
    const before = await readOutLedger(paths);
    expect(before.entries["old"]).toBeDefined();
  });
});

describe("레인 격리 — SC-016", () => {
  it("두 레인은 각자 ledger 파일을 가지며 상대 레인 엔트리를 담지 않는다", async () => {
    const pathsB = lanePaths(tmpBase, "myproj", "L2");
    fs.mkdirSync(pathsB.outDir, { recursive: true });

    await setDone(paths, "a1", {});
    await setDone(pathsB, "b1", {});

    expect(paths.outLedgerFile).not.toBe(pathsB.outLedgerFile);
    const ledgerA = await readOutLedger(paths);
    const ledgerB = await readOutLedger(pathsB);
    expect(ledgerA.entries["b1"]).toBeUndefined();
    expect(ledgerB.entries["a1"]).toBeUndefined();
  });
});

describe("스키마 진화·fail-open — SC-017", () => {
  it("ledger 파일 부재 시 빈 ledger(v:1)를 반환한다(크래시 없음)", async () => {
    const ledger = await readOutLedger(paths);
    expect(ledger.v).toBe(1);
    expect(ledger.entries).toEqual({});
  });

  it("v 미지 값은 best-effort 로 보존되고 크래시하지 않는다", async () => {
    fs.mkdirSync(path.dirname(paths.outLedgerFile), { recursive: true });
    fs.writeFileSync(
      paths.outLedgerFile,
      JSON.stringify({ v: 99, entries: { x: { state: "done", ts: "2026-01-01T00:00:00.000Z" } } }),
    );
    const ledger = await readOutLedger(paths);
    expect(ledger.entries["x"]).toBeDefined();
  });

  it("파싱 불가(파손) ledger 는 보조 빈값으로 fail-open 하고 전송 안전 보수적으로 처리한다", async () => {
    fs.mkdirSync(path.dirname(paths.outLedgerFile), { recursive: true });
    fs.writeFileSync(paths.outLedgerFile, "{ not json");
    const ledger = await readOutLedger(paths);
    expect(ledger.v).toBe(1);
    expect(ledger.entries).toEqual({});
  });
});

describe("migrateLegacyOut — GAP-002 방어분기: processing 잔존 orphan body 는 legacy done 으로 흡수하지 않는다", () => {
  it("<id>.out 만 존재(aux 마커 없음) + processing/<id>.msg 잔존 → 스킵(entry 미생성·body 보존·processing 보존)", async () => {
    // 신규 ledger 전이 중(writeOutBody 후 setDone 전) 크래시로 생긴 orphan body 를 구 시스템의
    // 완료 메시지로 오인 승격하면, 재개 시 scanProcessing 이 이미 done 으로 오판해 재처리(엔진
    // 재주입) 없이 processing 잔존 파일을 지워 무유실 불변식(NFR-001)을 깬다(GAP-002).
    const id = "orphan-crash";
    fs.mkdirSync(paths.processingDir, { recursive: true });
    fs.writeFileSync(path.join(paths.outDir, `${id}.out`), "전이 중 크래시로 남은 응답");
    fs.writeFileSync(path.join(paths.processingDir, `${id}.msg`), "{}");

    const result = await migrateLegacyOut(paths);

    expect(result.migrated).toBe(0);
    expect(await getEntry(paths, id)).toBeUndefined(); // done 으로 오인 승격되지 않음(방어분기 도달)
    expect(fs.existsSync(path.join(paths.outDir, `${id}.out`))).toBe(true); // body 보존
    expect(fs.existsSync(path.join(paths.processingDir, `${id}.msg`))).toBe(true); // 재처리 경로 유지
  });

  it("대조군 — processing 잔존이 없으면 <id>.out 만으로도 정상적으로 legacy done 흡수된다", async () => {
    const id = "legacy-done";
    fs.mkdirSync(paths.processingDir, { recursive: true }); // 존재하되 해당 id 의 잔존 파일은 없음
    fs.writeFileSync(path.join(paths.outDir, `${id}.out`), "구 시스템에서 완료된 응답");

    const result = await migrateLegacyOut(paths);

    expect(result.migrated).toBe(1);
    expect((await getEntry(paths, id))?.state).toBe("done");
    expect(fs.existsSync(path.join(paths.outDir, `${id}.out`))).toBe(true);
    expect(fs.existsSync(path.join(paths.processingDir, `${id}.msg`))).toBe(false);
  });
});

describe("atomic tmp→rename·파일 락 부재 — SC-018 (정적)", () => {
  it("각 상태 전이 함수가 atomicWrite 를 정확히 1회 호출하고 파일 락 API 를 사용하지 않는다", () => {
    const srcPath = path.join(process.cwd(), "src/core/out-ledger.ts");
    const src = fs.readFileSync(srcPath, "utf8");
    for (const fn of ["setDone", "setSending", "setSent", "setAborted", "setFailed"]) {
      const body = extractFunctionBody(src, fn);
      const atomicWriteCalls = (body.match(/atomicWrite\(/g) ?? []).length;
      expect(atomicWriteCalls, `${fn} 은 atomicWrite 를 정확히 1회 호출해야 한다`).toBe(1);
    }
    expect(src).not.toMatch(/\bflock\b|proper-lockfile|\.lock\(/);
  });
});

describe("엔진 종속 분기 부재·out/ 경로 유지 — SC-019 (정적)", () => {
  it("out-ledger.ts 에 엔진 종속 분기가 없고 산출 경로가 out/ 하위(outDir/outLedgerFile)로 유지된다", () => {
    const srcPath = path.join(process.cwd(), "src/core/out-ledger.ts");
    const src = fs.readFileSync(srcPath, "utf8");
    expect(src).not.toMatch(/backend\.engine|envelope\.engine|engine\s*===/);
    expect(src).toMatch(/paths\.outDir|paths\.outLedgerFile/);
  });
});
