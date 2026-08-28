import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securePrivateDirs } from "../../src/shared/fs-atomic.js";

// 내부 상태·큐 디렉터리 권한 잠금 프리미티브 — private=0700 / shared=no-op.
// 프로덕션 경로 배선(프로젝트 생성·데몬 기동에서 실제로 불리는가)은 file-mode-wiring.test.ts 가
// 별도로 확인한다 — 이 파일의 직접 호출 단언만으로는 호출처 0 상태를 통과시킨다(실제로 통과했다).

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

describe("securePrivateDirs", () => {
  it("private 모드는 부재 디렉터리를 생성하고 0700 으로 잠근다", async () => {
    const dir = join(base, "state", "lane1");
    await securePrivateDirs([dir], "private");
    expect(mode(dir)).toBe(0o700);
  });

  it("private 모드는 기존 느슨한(0755) 디렉터리도 0700 으로 조인다", async () => {
    const dir = join(base, "out", "lane1");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await securePrivateDirs([dir], "private");
    expect(mode(dir)).toBe(0o700);
  });

  it("여러 디렉터리를 한 번에 잠근다", async () => {
    const dirs = [join(base, "state", "l"), join(base, "queue", "l"), join(base, "out", "l")];
    await securePrivateDirs(dirs, "private");
    for (const d of dirs) expect(mode(d)).toBe(0o700);
  });

  it("shared 모드는 no-op — 기존 권한을 바꾸지 않는다(열람 허용 옵트인)", async () => {
    const dir = join(base, "state", "lane1");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await securePrivateDirs([dir], "shared");
    expect(mode(dir)).toBe(0o755);
  });

  it("shared 모드는 부재 디렉터리를 생성하지 않는다", async () => {
    const dir = join(base, "state", "absent");
    await securePrivateDirs([dir], "shared");
    let exists = true;
    try {
      statSync(dir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
