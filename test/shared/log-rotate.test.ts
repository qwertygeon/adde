import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  rotateGenerations,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_KEEP,
} from "../../src/shared/log-rotate.js";
import type { RotateConfig, RotateDeps } from "../../src/shared/log-rotate.js";

// 확정 시그니처 SSOT: design/research.md "확정 시그니처" 절.
// SC-007(회전·keep 유지)·SC-009(회전 실패 시 throw — 호출자 fail-open 은 transcript.test.ts 가 검증).

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-log-rotate-"));
  logPath = path.join(tmpDir, "app.log");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("상수", () => {
  it("DEFAULT_LOG_MAX_BYTES 는 5MB, DEFAULT_LOG_KEEP 은 2", () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_LOG_KEEP).toBe(2);
  });
});

describe("rotateGenerations (SC-007 Happy) — 임계 초과 회전·keep=2", () => {
  it("current→.1, 기존 .1→.2, 기존 .2(최고령) 삭제", async () => {
    fs.writeFileSync(logPath, "current-content");
    fs.writeFileSync(`${logPath}.1`, "gen1-content");
    fs.writeFileSync(`${logPath}.2`, "gen2-content");

    const cfg: RotateConfig = { maxBytes: 10, keep: 2 };
    await rotateGenerations(logPath, cfg);

    expect(fs.existsSync(logPath)).toBe(false); // current 는 rename 되어 사라짐(다음 write 가 재생성)
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("current-content");
    expect(fs.readFileSync(`${logPath}.2`, "utf8")).toBe("gen1-content");
    // 최고령(과거 .2 = "gen2-content")은 삭제되어 세대 수가 keep(2)를 넘지 않음.
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it("세대 파일이 정확히 keep 개수만 존재한다", async () => {
    fs.writeFileSync(logPath, "current");
    fs.writeFileSync(`${logPath}.1`, "gen1");
    fs.writeFileSync(`${logPath}.2`, "gen2");

    await rotateGenerations(logPath, { maxBytes: 10, keep: 2 });

    const generations = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("app.log."));
    expect(generations.sort()).toEqual(["app.log.1", "app.log.2"]);
  });
});

describe("rotateGenerations (Edge) — 부재 세대 ENOENT 흡수", () => {
  it("최초 회전(.1·.2 부재)에서도 throw 없이 current→.1 로 완료", async () => {
    fs.writeFileSync(logPath, "first-current");

    await expect(rotateGenerations(logPath, { maxBytes: 10, keep: 2 })).resolves.toBeUndefined();

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("first-current");
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
  });

  it("keep=1 일 때 .1 만 유지되고 그 이상 세대는 생성되지 않는다", async () => {
    fs.writeFileSync(logPath, "current");
    fs.writeFileSync(`${logPath}.1`, "old-gen1");

    await rotateGenerations(logPath, { maxBytes: 10, keep: 1 });

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("current");
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
  });
});

describe("rotateGenerations (SC-009 Error) — 회전 연산 실패 시 throw", () => {
  it("rename 실패 시 throw 한다(호출자가 fail-open 흡수할 대상)", async () => {
    fs.writeFileSync(logPath, "current");
    const deps: RotateDeps = {
      rename: async () => {
        throw new Error("rename-fail (simulated EACCES)");
      },
    };

    await expect(rotateGenerations(logPath, { maxBytes: 10, keep: 2 }, deps)).rejects.toThrow();
  });

  it("unlink 실패(ENOENT 아닌 실오류) 시 throw 한다", async () => {
    fs.writeFileSync(logPath, "current");
    fs.writeFileSync(`${logPath}.1`, "gen1");
    fs.writeFileSync(`${logPath}.2`, "gen2");
    const deps: RotateDeps = {
      unlink: async () => {
        throw new Error("unlink-fail (simulated EACCES)");
      },
    };

    await expect(rotateGenerations(logPath, { maxBytes: 10, keep: 2 }, deps)).rejects.toThrow();
  });

  it("실패한 회전 시도 후에도 정상 deps 로 재호출하면 성공한다(영구 손상 없음)", async () => {
    fs.writeFileSync(logPath, "current-1");
    const failingDeps: RotateDeps = {
      rename: async () => {
        throw new Error("simulated failure");
      },
    };
    await expect(
      rotateGenerations(logPath, { maxBytes: 10, keep: 2 }, failingDeps),
    ).rejects.toThrow();

    // 실패로 인해 current 는 그대로 남아있어야 다음 정상 호출이 유효하다.
    expect(fs.existsSync(logPath)).toBe(true);
    await expect(rotateGenerations(logPath, { maxBytes: 10, keep: 2 })).resolves.toBeUndefined();
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("current-1");
  });
});

describe("rotateGenerations — deps 주입 호출 검증", () => {
  it("주입된 rename·unlink 가 실제로 호출된다(fs.promises 대체 확인)", async () => {
    fs.writeFileSync(logPath, "current");
    fs.writeFileSync(`${logPath}.1`, "gen1");
    const renameCalls: Array<[string, string]> = [];
    const unlinkCalls: string[] = [];
    const deps: RotateDeps = {
      rename: async (a, b) => {
        renameCalls.push([a, b]);
        fs.renameSync(a, b);
      },
      unlink: async (p) => {
        unlinkCalls.push(p);
        try {
          fs.unlinkSync(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      },
    };

    await rotateGenerations(logPath, { maxBytes: 10, keep: 2 }, deps);

    expect(renameCalls.length).toBeGreaterThan(0);
    expect(unlinkCalls).toContain(`${logPath}.2`);
  });
});
