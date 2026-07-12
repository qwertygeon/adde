import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeBootReport, readBootReport } from "../../src/core/boot-report.js";
import { daemonBootReportPath } from "../../src/shared/paths.js";
import type { LaneStatus } from "../../src/core/supervisor.js";

// SC-011(NFR-002 마스킹) + writeBootReport/readBootReport round-trip·bootId 단조 증가·손상 파일
// fail-safe(null) — boot-report.ts 단위 검증. 데몬 단일 writer 를 가정해 실 fs(tmp 격리)로 검증한다.

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-boot-report-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("writeBootReport → readBootReport round-trip", () => {
  it("기록한 레인 상태·running 카운트를 그대로 읽어온다(정상 레인은 error 필드 없음)", async () => {
    const lanes: LaneStatus[] = [
      { lane: "a", status: "running" },
      { lane: "b", status: "error", error: "bad conf" },
    ];
    const bootId = await writeBootReport(tmpBase, "proj1", lanes, () => 1_700_000_000_000);
    expect(bootId).toBe(1);

    const report = await readBootReport(tmpBase, "proj1");
    expect(report).not.toBeNull();
    expect(report?.v).toBe(1);
    expect(report?.bootId).toBe(1);
    expect(report?.bootedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(report?.running).toBe(1);
    const laneA = report?.lanes.find((l) => l.lane === "a");
    expect(laneA?.status).toBe("running");
    expect(laneA?.error).toBeUndefined();
    const laneB = report?.lanes.find((l) => l.lane === "b");
    expect(laneB?.status).toBe("error");
    expect(laneB?.error).toBe("bad conf");
  });

  it("빈 레인 배열(lanes=[])도 running=0 리포트로 정상 기록된다", async () => {
    await writeBootReport(tmpBase, "proj-empty", []);
    const report = await readBootReport(tmpBase, "proj-empty");
    expect(report?.lanes).toEqual([]);
    expect(report?.running).toBe(0);
  });
});

describe("bootId 단조 증가 — 직전 리포트 + 1", () => {
  it("첫 기록은 bootId=1, 두 번째 기록은 직전 값 + 1 이다", async () => {
    const first = await writeBootReport(tmpBase, "proj2", [{ lane: "a", status: "running" }]);
    const second = await writeBootReport(tmpBase, "proj2", [{ lane: "a", status: "running" }]);
    const third = await writeBootReport(tmpBase, "proj2", [{ lane: "a", status: "running" }]);
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
  });
});

describe("readBootReport fail-safe — 손상/스키마 불일치 시 null", () => {
  it("파일 부재 시 null 을 반환한다", async () => {
    expect(await readBootReport(tmpBase, "no-such-proj")).toBeNull();
  });

  it("파싱 불가한(JSON 아닌) 내용은 null 을 반환한다", async () => {
    const p = daemonBootReportPath(tmpBase, "proj3");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not valid json");
    expect(await readBootReport(tmpBase, "proj3")).toBeNull();
  });

  it("스키마 버전(v!==1) 불일치 시 null 을 반환한다(fail-safe — 이후 baseline=0 취급으로 이어짐)", async () => {
    const p = daemonBootReportPath(tmpBase, "proj4");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ v: 2, bootId: 5, bootedAt: "x", lanes: [], running: 0 }));
    expect(await readBootReport(tmpBase, "proj4")).toBeNull();
  });

  it("손상 리포트 이후에도 다음 기록은 bootId=1 부터 정상 재개된다(손상이 판정을 막지 않음)", async () => {
    const p = daemonBootReportPath(tmpBase, "proj5");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "corrupt");
    const bootId = await writeBootReport(tmpBase, "proj5", [{ lane: "a", status: "running" }]);
    expect(bootId).toBe(1); // 손상된 prev 를 null 로 보아 (prev?.bootId ?? 0) + 1 = 1
  });
});

describe("사유 마스킹 (SC-011 Error)", () => {
  it("error 레인의 사유에 토큰 유사 문자열이 섞이면 마스킹되어 기록된다", async () => {
    const secretish = "token=sk-abcdefghijklmnopqrstuvwx failure";
    await writeBootReport(tmpBase, "proj-secret", [
      { lane: "leaky", status: "error", error: secretish },
    ]);
    const report = await readBootReport(tmpBase, "proj-secret");
    const lane = report?.lanes.find((l) => l.lane === "leaky");
    expect(lane?.error).toContain("***");
    expect(lane?.error).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("사유가 없는 error 레인은 빈 문자열 마스킹 결과를 기록한다(원문 부재를 throw 로 만들지 않음)", async () => {
    await writeBootReport(tmpBase, "proj-noerr", [{ lane: "x", status: "error" }]);
    const report = await readBootReport(tmpBase, "proj-noerr");
    expect(report?.lanes.find((l) => l.lane === "x")?.error).toBe("");
  });
});
