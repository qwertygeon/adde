import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureLaneDirs } from "../../src/shared/fs-atomic.js";

// 레인 상태·출력·큐 디렉터리 권한 잠금 — private=0700 / shared=no-op.

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "adde-fsatomic-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 하위 12비트 권한 추출. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("secureLaneDirs", () => {
  it("private 모드는 부재 디렉터리를 생성하고 0700 으로 잠근다", async () => {
    const dir = join(base, "state", "lane1");
    await secureLaneDirs([dir], "private");
    expect(mode(dir)).toBe(0o700);
  });

  it("private 모드는 기존 느슨한(0755) 디렉터리도 0700 으로 조인다", async () => {
    const dir = join(base, "out", "lane1");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await secureLaneDirs([dir], "private");
    expect(mode(dir)).toBe(0o700);
  });

  it("여러 디렉터리를 한 번에 잠근다", async () => {
    const dirs = [join(base, "state", "l"), join(base, "queue", "l"), join(base, "out", "l")];
    await secureLaneDirs(dirs, "private");
    for (const d of dirs) expect(mode(d)).toBe(0o700);
  });

  it("shared 모드는 no-op — 기존 권한을 바꾸지 않는다(열람 허용 옵트인)", async () => {
    const dir = join(base, "state", "lane1");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await secureLaneDirs([dir], "shared");
    expect(mode(dir)).toBe(0o755);
  });

  it("shared 모드는 부재 디렉터리를 생성하지 않는다", async () => {
    const dir = join(base, "state", "absent");
    await secureLaneDirs([dir], "shared");
    let exists = true;
    try {
      statSync(dir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
