import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --json 확대 산출물의 시크릿 비노출 (NFR-002·A-P003). up --json 은 이미 write-time
// maskSecrets 가 적용된 BootReport(boot-report.ts)를 재사용하므로 신규 마스킹 로직이 필요 없다 —
// 실 writeBootReport 를 통해 기록한 뒤 실 readBootReport 로 읽는 전 경로를 관통시켜, up --json 이
// 마스킹을 우회하는 신규 노출 경로를 만들지 않았음을 회귀로 확인한다(더블은 launchd/diagnostics
// 만 대체 — boot-report 는 실 구현 사용).
//
// 실측(v2, GAP-026 정정): writeBootReport(base, proj, sessions: SessionStatusRow[]) 는 detached
// 세션의 error 필드를 호출자가 넘긴 사유 문자열이 아니라 **고정 리터럴** `maskSecrets("detached")`
// 로 채운다(src/core/boot-report.ts writeBootReport — `error: maskSecrets("detached")`,
// SessionStatusRow 자체에도 사유 필드가 없음). 즉 v0.2.x 처럼 실패 사유(raw 토큰 포함 가능)를
// BootReport 에 그대로 전달할 입력 경로가 v2 에는 존재하지 않는다 — 원 시나리오("raw 토큰이 write-time
// 마스킹으로 가려짐")를 재현할 입력 자체가 없다(공격 표면 자체가 소멸). 본 테스트는 이 축소된 계약을
// 회귀 가드로 재작성한다: detached 세션의 error 필드가 항상 안전한 고정 리터럴이고 임의 입력이 그대로
// 반영되지 않음을 확인한다.

const RAW_TOKEN = `123456789:${"A".repeat(40)}`; // BOT_TOKEN_PATTERN 매치(ops-secret-mask.test.ts 관행)

const { loadDaemon, unloadDaemon, daemonRegState, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));
vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon, daemonRegState }));
vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus, clearHalt }));

import { run } from "../../src/cli/run.js";
import { writeBootReport } from "../../src/core/boot-report.js";

let tmpBase: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-up-json-secret-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
  daemonRegState.mockResolvedValue({ launchctlRegistered: false });
  clearHalt.mockResolvedValue(undefined);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("up --json — detached 세션의 error 필드는 항상 안전한 고정 리터럴이다", () => {
  it("실 writeBootReport 관통 — 임의 입력(raw 토큰 포함 SessionStatusRow)을 넘겨도 error 필드는 고정 리터럴만 노출된다", async () => {
    // loadDaemon(가짜 데몬 적재) 완료 시점에 데몬이 실제로 리포트를 쓰는 것을 흉내낸다 —
    // waitForBootReport 가 폴링을 시작하기 전에 이미 (bootId=1 > baseline=0) 리포트가 존재.
    // title 등 SessionStatusRow 의 다른 필드에 raw 토큰을 실어도(가능한 유일한 주입 지점)
    // writeBootReport 의 BootReportSession 매핑({sid,status,error?})이 title 을 아예 포함하지
    // 않으므로 --json 산출물에 노출될 경로가 없다.
    loadDaemon.mockImplementation(async () => {
      // 진단용 리치 로우(engine·title 등)를 그대로 넘긴다 — writeBootReport 의 파라미터 타입은
      // sid·status 만 요구하므로 변수로 우회 대입해 초과 속성이 런타임에 남게 한다.
      const richRow = {
        sid: "bad",
        status: "detached" as const,
        engine: "acp",
        engineRef: null,
        title: `token=${RAW_TOKEN}`,
        lastActivityAt: new Date().toISOString(),
        enginePresent: false,
      };
      await writeBootReport(tmpBase, "p", [richRow]);
    });
    const cap = captureStdout();
    const code = await run(["up", "p", "--json"]);
    cap.restore();
    const raw = cap.out();
    expect(raw).not.toContain(RAW_TOKEN);
    const parsed = JSON.parse(raw) as { sessions: Array<{ sid: string; error?: string }> };
    const bad = parsed.sessions.find((s) => s.sid === "bad");
    expect(bad?.error).toBeDefined();
    expect(bad?.error).not.toContain(RAW_TOKEN);
    expect(bad?.error).toBe("detached"); // 고정 리터럴 — 사유 상세는 v2 BootReport 에 실리지 않음
    expect(code).toBe(1); // detached 세션 존재
  });
});
