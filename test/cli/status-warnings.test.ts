import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// 세션 경고는 지금까지 `session show` 에서만 보였다 — 사용자가 그 명령을 실행할 이유를 모르면
// 저장 실패·재개 실패가 기록만 되고 전달되지 않는다. `status` 표에 경고 유무를 실어 발견성을
// 확보하되, 상세는 `session show` 로 유도한다(표가 길어지지 않도록).

const PROJ = "p1";
let tmpHome: string;
let vaultDir: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-warn-"));
  process.env["ADDE_HOME"] = path.join(tmpHome, "adde");
  vaultDir = path.join(tmpHome, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const projDir = path.join(process.env["ADDE_HOME"]!, "projects", PROJ);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultDir}\n`);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  vi.restoreAllMocks();
});

async function writeRecord(sid: string, warnings: string[]): Promise<void> {
  const store = await import("../../src/core/session-store.js");
  await store.saveSession(
    process.env["ADDE_HOME"]!,
    PROJ,
    makeSessionRecordFixture(sid, { status: "hibernated", warnings }),
  );
}

async function captureStatus(args: string[]): Promise<string> {
  const ops = await import("../../src/cli/ops.js");
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await ops.runStatus(args);
  return out;
}

describe("status 의 세션 경고 노출", () => {
  it("Happy: 경고가 있는 세션은 WARN 에 개수가, 없는 세션은 - 가 표시된다", async () => {
    await writeRecord("sid-warn", ["storage-failed: 턴 3 노트 저장 실패", "resume-failed: 없음"]);
    await writeRecord("sid-clean", []);

    const out = await captureStatus([PROJ]);
    expect(out).toContain("WARN");
    const warnRow = out.split("\n").find((l) => l.includes("sid-warn"))!;
    const cleanRow = out.split("\n").find((l) => l.includes("sid-clean"))!;
    expect(warnRow).toMatch(/\s2\s/); // 경고 2건
    expect(cleanRow).toMatch(/\s-\s/);
  });

  it("Happy: 표에 경고 본문을 싣지 않는다(상세는 session show 로 유도)", async () => {
    await writeRecord("sid-warn", ["storage-failed: 턴 3 노트 저장 실패"]);
    const out = await captureStatus([PROJ]);
    expect(out).not.toContain("노트 저장 실패"); // 표가 경고 본문으로 넓어지지 않는다
  });

  it("Happy: --json 은 경고 배열을 additive 로 싣고 스키마 버전은 불변이다", async () => {
    await writeRecord("sid-warn", ["storage-failed: x"]);
    const parsed = JSON.parse(await captureStatus([PROJ, "--json"])) as {
      v: number;
      sessions: Array<{ sid: string; status: string; warnings: string[] }>;
    };
    expect(parsed.v).toBe(1); // additive — 버전 bump 없음
    const row = parsed.sessions.find((s) => s.sid === "sid-warn")!;
    expect(row.warnings).toEqual(["storage-failed: x"]);
    expect(row.status).toBe("hibernated"); // status 값 자체는 오염되지 않는다
  });
});
