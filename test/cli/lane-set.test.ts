import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runLane } from "../../src/cli/lane.js";
import { laneAdd } from "../../src/core/lane-config.js";
import { t } from "../../src/shared/i18n.js";

// 017-lane-set D2 (5a AUTHORING) — CLI 경로: 정체성 pre-scan 친절 거부(SC-004)·safe-defaults
// 미지원 거부(SC-003)·no-op(SC-009 CLI)·restart 무조건 안내(SC-015)·교차소스 CLI 거부(SC-010 CLI).
// `runLane(["set", ...])` 은 B2(LANE_SUBS 등록)·C2(handleSet) 착지 전까지 "unknown lane sub" 로
// 응답한다(findSub 미매칭) — PPG-1 병렬 중 예상 RED(PROC-R15), 병렬 착지 후 5b 에서 GREEN 수렴한다.
// ADDE_HOME 을 임시 디렉터리로 override 해 실 홈 디렉터리와 격리한다(cli/run-boot.test.ts 관례).

const tAny = t as unknown as (key: string, params?: Record<string, unknown>) => string;

let tmpHome: string;
let prevAddeHome: string | undefined;

beforeEach(() => {
  prevAddeHome = process.env["ADDE_HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lane-set-cli-"));
  process.env["ADDE_HOME"] = tmpHome;
});

afterEach(() => {
  if (prevAddeHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevAddeHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureStdio(): { out: () => string; err: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    outChunks.push(String(s));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    errChunks.push(String(s));
    return true;
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
    },
  };
}

describe("정체성 필드 친절 거부 (SC-004)", () => {
  it.each([
    ["--source", "telegram"],
    ["--backend", "acp"],
    ["--engine", "claude-agent-acp"],
    ["--acp-version", "v1"],
  ])("%s 편집은 exit 1 이고 conf 가 변경되지 않는다", async (flag, value) => {
    const lane = `laneid-${flag.replace(/^--/, "")}`;
    const { confPath } = await laneAdd("proj", lane, {});
    const before = fs.readFileSync(confPath, "utf8");

    const cap = captureStdio();
    const code = await runLane(["set", "proj", lane, flag, value]);
    cap.restore();

    expect(code, `${flag} 편집은 exit 1 이어야 한다`).toBe(1);
    expect(fs.readFileSync(confPath, "utf8"), `${flag} 편집 거부 시 conf 무변경`).toBe(before);
  });

  it("--flag=value 형(등호)도 동일하게 exit 1 로 거부된다", async () => {
    await laneAdd("proj", "laneideq", {});

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "laneideq", "--source=telegram"]);
    cap.restore();

    expect(code).toBe(1);
  });

  it("정체성 플래그 거부는 plain unknown-flag 문구가 아니라 전용 오류다(대조 — 진짜 미지원 플래그와 구분)", async () => {
    await laneAdd("proj", "laneidctrl", {});

    const capIdentity = captureStdio();
    await runLane(["set", "proj", "laneidctrl", "--source", "telegram"]);
    capIdentity.restore();

    const capBogus = captureStdio();
    await runLane(["set", "proj", "laneidctrl", "--totally-bogus-flag", "x"]);
    capBogus.restore();

    // 대조군(진짜 미지원 플래그)은 plain unknown-flag 문구를 포함해야 한다.
    expect(capBogus.err()).toContain(tAny("cli.unknownFlag", { flag: "--totally-bogus-flag" }));
    // 정체성 플래그는 동일한 plain unknown-flag 문구를 쓰지 않는다(친절 오류로 분기, FR-004).
    expect(capIdentity.err()).not.toContain(tAny("cli.unknownFlag", { flag: "--source" }));
    expect(capIdentity.err()).toContain("--source");
  });
});

describe("safe-defaults 미지원 (SC-003)", () => {
  it("--safe-defaults 는 미지원 플래그로 거부되고(오류+usage) conf 는 변경되지 않는다", async () => {
    const { confPath } = await laneAdd("proj", "lanesd", {});
    const before = fs.readFileSync(confPath, "utf8");

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "lanesd", "--safe-defaults"]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err()).toContain(tAny("cli.unknownFlag", { flag: "--safe-defaults" }));
    expect(cap.err()).toContain(tAny("usage.lane"));
    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });
});

describe("no-op CLI (SC-009)", () => {
  it("편집 플래그 없이 set 호출은 exit 1 이고 conf 는 변경되지 않는다", async () => {
    const { confPath } = await laneAdd("proj", "lanenoop", {});
    const before = fs.readFileSync(confPath, "utf8");

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "lanenoop"]);
    cap.restore();

    expect(code).toBe(1);
    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });
});

describe("restart 무조건 안내 (SC-015)", () => {
  it("편집 성공 시 데몬 상태 판정 없이 restart 안내(adde restart <proj>)가 표준출력에 포함된다", async () => {
    await laneAdd("proj", "lanerestart", {});

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "lanerestart", "--cwd", "/tmp/b"]);
    cap.restore();

    expect(code).toBe(0);
    // 정확한 문구는 C1(i18n) 소관이나, 기존 restart 안내 관례(ko/en 공통 "adde restart {{proj}}"
    // 리터럴 임베드 — messages.ts/locales 의 다른 restart 힌트들과 동일 패턴)를 따른다.
    expect(cap.out()).toMatch(/adde restart/);
    expect(cap.out()).toContain("proj");
  });
});

describe("교차소스 CLI 거부 (SC-010)", () => {
  it("markdown 레인에 --chat-id 편집은 거부되고 conf 는 변경되지 않는다", async () => {
    const { confPath } = await laneAdd("proj", "lanexsrc1", { source: "markdown" });
    const before = fs.readFileSync(confPath, "utf8");

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "lanexsrc1", "--chat-id", "123"]);
    cap.restore();

    expect(code).toBe(1);
    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });

  it("telegram 레인에 --root 편집은 거부되고 conf 는 변경되지 않는다(대칭)", async () => {
    const { confPath } = await laneAdd("proj", "lanexsrc2", { source: "telegram", chat_id: "1" });
    const before = fs.readFileSync(confPath, "utf8");

    const cap = captureStdio();
    const code = await runLane(["set", "proj", "lanexsrc2", "--root", "/v"]);
    cap.restore();

    expect(code).toBe(1);
    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });
});
