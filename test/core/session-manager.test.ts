import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";

const PROJ = "p1";

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSessionManager() {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const sm = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
  );
  return { sm, sessionStore };
}

describe("SC-005: 같은 경로의 활성 세션 수가 생성 시점에 표기된다", () => {
  it("Happy: 활성 2개가 있는 경로에 세션을 하나 더 만들면 activeSameCwd=3 이 반환된다", async () => {
    const { sm } = await makeSessionManager();
    await sm.create({ engine: "acp" });
    await sm.create({ engine: "acp" });
    const third = await sm.create({ engine: "acp" });
    expect(third.activeSameCwd).toBe(3);
  });

  it("Edge: 활성 0개 상태의 첫 생성은 activeSameCwd=1 이다", async () => {
    const { sm } = await makeSessionManager();
    const first = await sm.create({ engine: "acp" });
    expect(first.activeSameCwd).toBe(1);
  });

  it("Error: 레지스트리에 없는 엔진 id 로 생성하면 거부된다(생성 실패 경로 일반화)", async () => {
    const [sessionStore, sessionManagerMod] = await Promise.all([
      import("../../src/core/session-store.js"),
      import("../../src/core/session-manager.js"),
    ]);
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    void sessionStore;
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    await expect(sm.create({ engine: "does-not-exist" })).rejects.toThrow();
  });
});

describe("SC-011: 유휴 임계·상한·온오프가 설정으로 바뀐다", () => {
  it("Happy: hibernate_after_min=5·max_active_engines=1·auto_resume=false 가 파싱 결과에 반영된다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const text = [
      "v=1",
      "vault=/tmp/unused-vault",
      "hibernate_after_min=5",
      "max_active_engines=1",
      "auto_resume=false",
    ].join("\n");
    const parsed = confMod.parseProjectConf(text);
    expect(parsed.hibernate_after_min).toBe(5);
    expect(parsed.max_active_engines).toBe(1);
    expect(parsed.auto_resume).toBe(false);
  });

  it("Edge: 0·음수 값은 기본값으로 폴백하고 경고를 남긴다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const text = [
      "v=1",
      "vault=/tmp/unused-vault",
      "hibernate_after_min=-5",
      "max_active_engines=0",
    ].join("\n");
    const parsed = confMod.parseProjectConf(text) as {
      hibernate_after_min: number;
      max_active_engines: number;
      warnings?: string[];
    };
    expect(parsed.hibernate_after_min).toBe(30); // 기본값 폴백
    expect(parsed.max_active_engines).toBe(3);
    expect(parsed.warnings?.length ?? 0).toBeGreaterThan(0);
  });

  it("Error: 비수치 값은 파싱 거부되고 기본값이 적용된다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const text = ["v=1", "vault=/tmp/unused-vault", "hibernate_after_min=notanumber"].join("\n");
    const parsed = confMod.parseProjectConf(text) as { hibernate_after_min: number };
    expect(parsed.hibernate_after_min).toBe(30);
  });
});

describe("SC-043: 기본값과 옵트아웃이 선언대로 동작한다(NFR-009)", () => {
  it("Happy: 무설정 프로젝트는 auto_resume·idle_hibernate·auto_relaunch 켬이고 vault.backup·markdown.records_cap 은 꺼져 있다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const parsed = confMod.parseProjectConf("v=1\nvault=/tmp/unused-vault\n") as {
      auto_resume: boolean;
      idle_hibernate: boolean;
      hibernate_after_min: number;
      max_active_engines: number;
      auto_relaunch: boolean;
      "vault.backup"?: string;
      "vault.retention_days": number;
      "vault.sync_provider": string;
      "markdown.records_cap"?: number;
    };
    // ProjectConf 는 평면 점표기 키(실측 src/shared/conf.ts) — `vault` 자체는 저장소 루트 경로
    // string 필드라 nested 객체로 두면 필드 충돌이 난다(정정: PPG-1 rework3, GAP-020).
    expect(parsed.auto_resume).toBe(true);
    expect(parsed.idle_hibernate).toBe(true);
    expect(parsed.hibernate_after_min).toBe(30);
    expect(parsed.max_active_engines).toBe(3);
    expect(parsed.auto_relaunch).toBe(true);
    expect(parsed["vault.backup"]).toBeUndefined();
    expect(parsed["vault.retention_days"]).toBe(2);
    expect(parsed["vault.sync_provider"]).toBe("local");
    expect(parsed["markdown.records_cap"]).toBeUndefined();
  });

  it("Edge: auto_resume 만 끈 프로젝트는 idle_hibernate 는 여전히 켬이다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const parsed = confMod.parseProjectConf(
      "v=1\nvault=/tmp/unused-vault\nauto_resume=false\n",
    ) as { auto_resume: boolean; idle_hibernate: boolean };
    expect(parsed.auto_resume).toBe(false);
    expect(parsed.idle_hibernate).toBe(true);
  });

  it("Error: 세션별 작업트리 격리 키를 지정해도 침묵 활성화되지 않고 미지원 안내로 처리된다", async () => {
    const confMod = await import("../../src/shared/conf.js");
    const text = ["v=1", "vault=/tmp/unused-vault", "worktree_isolation=true"].join("\n");
    const parsed = confMod.parseProjectConf(text) as { warnings?: string[] };
    // 스펙 범위 외 키 — 조용히 적용되지 않고 경고로 표면화된다(SC-043 Error: 침묵 활성 0).
    expect(parsed.warnings?.some((w) => /worktree/i.test(w))).toBe(true);
  });
});
