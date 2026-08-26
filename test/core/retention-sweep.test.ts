import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// helper/regression(SC 매핑 없음) — SEC-002/GAP-036: runRetention() 이 production 어디서도
// 호출되지 않던 배선 누락 해소 검증. SessionManager 의 60초 스윕 타이머가 vault.backup 지정
// 프로젝트에 한해 실제로 runRetention() 을 호출해 오래된 턴 노트를 이관하고, 결과를
// retention-last-run 게이트 파일에 기록하는지 확인한다(doctor 표면화의 데이터 소스).

const PROJ = "retp1";
let roots: V2TmpRoots;
let backupDir: string;

beforeEach(() => {
  roots = makeV2TmpRoots();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-retention-backup-"));
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe("SEC-002 회귀: 일간 보관 이관 스윕이 실제로 배선된다", () => {
  it("vault.backup 지정 프로젝트는 스윕 타이머에서 오래된 턴 노트를 이관하고 결과를 기록한다", async () => {
    const [{ createSessionManager }, { vaultPaths }, retentionMod] = await Promise.all([
      import("../../src/core/session-manager.js"),
      import("../../src/shared/paths.js"),
      import("../../src/record/retention.js"),
    ]);
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);

    let sweepFn: (() => void) | undefined;
    const deps = makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      {
        conf: { "vault.backup": backupDir, "vault.retention_days": 1 },
        scheduler: {
          setInterval: (fn: () => void) => {
            sweepFn = fn;
            return 1;
          },
          clearInterval: () => {},
        },
      },
    );
    const sm = createSessionManager(deps as never);
    const created = await sm.create({ engine: "acp" });
    const sid = created.sid;

    // 오래된(2020-01-01) 턴 노트를 직접 배치 — isArchivedTurn(retentionDays=1) 대상이 되도록.
    const vp = vaultPaths(roots.vaultRoot, PROJ, sid);
    fs.mkdirSync(vp.turnsDir, { recursive: true });
    const turnFileName = "0001 2020-01-01T00-00-00.md";
    const turnPath = path.join(vp.turnsDir, turnFileName);
    fs.writeFileSync(turnPath, "# 오래된 턴\n");

    expect(sweepFn, "setInterval 콜백이 등록되지 않음").toBeDefined();
    sweepFn!(); // idle sweep + retention sweep 을 함께 트리거(fire-and-forget) — 아래에서 결과를 폴링.

    await waitFor(() => !fs.existsSync(turnPath));
    const movedPath = path.join(backupDir, "2020-01-01", "sessions", sid, "turns", turnFileName);
    expect(fs.existsSync(movedPath)).toBe(true);

    await waitFor(() =>
      fs.existsSync(path.join(roots.base, "projects", PROJ, "runtime", "retention-last-run")),
    );
    const lastRun = await retentionMod.readRetentionLastRun(roots.base, PROJ);
    expect(lastRun).not.toBeNull();
    expect(lastRun!.moved).toBeGreaterThanOrEqual(1);
    expect(lastRun!.skipped).toBe(0);
  });

  it("vault.backup 미지정 프로젝트는 스윕이 실행돼도 아무 파일도 이동하지 않는다(NFR-009 옵트인)", async () => {
    const [{ createSessionManager }, { vaultPaths }, retentionMod] = await Promise.all([
      import("../../src/core/session-manager.js"),
      import("../../src/shared/paths.js"),
      import("../../src/record/retention.js"),
    ]);
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);

    let sweepFn: (() => void) | undefined;
    const deps = makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      {
        scheduler: {
          setInterval: (fn: () => void) => {
            sweepFn = fn;
            return 1;
          },
          clearInterval: () => {},
        },
      },
    );
    const sm = createSessionManager(deps as never);
    const created = await sm.create({ engine: "acp" });
    const vp = vaultPaths(roots.vaultRoot, PROJ, created.sid);
    fs.mkdirSync(vp.turnsDir, { recursive: true });
    const turnPath = path.join(vp.turnsDir, "0001 2020-01-01T00-00-00.md");
    fs.writeFileSync(turnPath, "# 오래된 턴\n");

    sweepFn!();
    await new Promise((r) => setTimeout(r, 50)); // 비활성 경로는 신호가 없으므로 짧게 정지 대기.

    expect(fs.existsSync(turnPath)).toBe(true); // 이동되지 않음.
    expect(await retentionMod.readRetentionLastRun(roots.base, PROJ)).toBeNull(); // 게이트 파일도 안 씀.
  });
});

describe("회귀: 스윕이 실행 시점에 보관 위치 겹침을 재검증한다", () => {
  it("project.conf 가 CLI 검증을 우회해 겹치는 보관 위치를 갖고 있으면 이관을 건너뛰고 경고를 남긴다", async () => {
    const [{ createSessionManager }, { vaultPaths }, retentionMod, events] = await Promise.all([
      import("../../src/core/session-manager.js"),
      import("../../src/shared/paths.js"),
      import("../../src/record/retention.js"),
      import("../../src/record/events.js"),
    ]);
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);

    // CLI(`project add`/`project set`)를 거치지 않고 저장소 루트 *안* 을 보관 위치로 지정한 상태 —
    // 파일을 직접 편집했거나 검증 이후 vault 가 재배치된 경우에 해당한다.
    const overlapping = path.join(roots.vaultRoot, "backup");

    let sweepFn: (() => void) | undefined;
    const deps = makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      {
        conf: { "vault.backup": overlapping, "vault.retention_days": 1 },
        scheduler: {
          setInterval: (fn: () => void) => {
            sweepFn = fn;
            return 1;
          },
          clearInterval: () => {},
        },
      },
    );
    const sm = createSessionManager(deps as never);
    const created = await sm.create({ engine: "acp" });
    const sid = created.sid;

    const vp = vaultPaths(roots.vaultRoot, PROJ, sid);
    fs.mkdirSync(vp.turnsDir, { recursive: true });
    const turnFileName = "0001 2020-01-01T00-00-00.md";
    const turnPath = path.join(vp.turnsDir, turnFileName);
    fs.writeFileSync(turnPath, "# 오래된 턴\n");

    expect(sweepFn, "setInterval 콜백이 등록되지 않음").toBeDefined();
    sweepFn!();

    // 경고 이벤트가 도착할 때까지 대기 — 겹침이면 건너뛰므로 파일 이동 신호가 없어 경고가 유일한 신호.
    const ctx = makeRecordCtx(roots, PROJ, sid) as never;
    await waitFor(async () => {
      for await (const e of events.readEvents(ctx)) {
        const ev = e as { t: string; kind?: string; message?: string };
        if (ev.t === "note" && ev.kind === "warning" && (ev.message ?? "").includes("겹쳐")) {
          return true;
        }
      }
      return false;
    });

    expect(fs.existsSync(turnPath), "겹침인데 턴 노트가 이동됨").toBe(true);
    expect(fs.existsSync(overlapping), "겹치는 보관 경로가 생성됨").toBe(false);
    // last-run 을 기록하지 않아야 한다 — 설정을 고치면 다음 tick 에 곧바로 재시도돼야 하므로.
    expect(await retentionMod.readRetentionLastRun(roots.base, PROJ)).toBeNull();
    // 이관 신호(파일 이동)가 없고 이벤트 기록 폴링만으로 판정하므로, 병렬 스위트의 디스크 경합에서
    // vitest 기본 5초 테스트 상한에 걸릴 수 있다 — waitFor 상한(8초)보다 넉넉하게 둔다.
  }, 15000);
});
