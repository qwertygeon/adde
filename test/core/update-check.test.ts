import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkForUpdate, compareSemver } from "../../src/core/update-check.js";

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-upd-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** version 을 반환하는 가짜 npm 레지스트리 fetch. */
function fakeFetch(version: string): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({ version }),
    }) as unknown as Response) as typeof fetch;
}

const failFetch: typeof fetch = (async () => {
  throw new Error("network down");
}) as typeof fetch;

describe("compareSemver", () => {
  it("숫자 파트를 비교한다", () => {
    expect(compareSemver("0.1.3", "0.1.4")).toBe(-1);
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("v0.1.3", "0.1.3")).toBe(0);
  });

  it("프리릴리스·빌드 메타를 무시한다", () => {
    expect(compareSemver("0.1.3-rc1", "0.1.3")).toBe(0);
    expect(compareSemver("0.1.3+build", "0.1.3")).toBe(0);
  });

  it("파싱 불가 시 0(비교 불가)", () => {
    expect(compareSemver("abc", "0.1.3")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  it("최신이 더 높으면 안내 반환", async () => {
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: true,
      fetchImpl: fakeFetch("0.1.4"),
      optOut: undefined,
    });
    expect(notice).toEqual({ current: "0.1.3", latest: "0.1.4" });
  });

  it("최신과 같거나 낮으면 null", async () => {
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.4",
      allowNetwork: true,
      fetchImpl: fakeFetch("0.1.4"),
      optOut: undefined,
    });
    expect(notice).toBeNull();
  });

  it("네트워크 조회 결과를 캐시에 기록한다", async () => {
    await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: true,
      fetchImpl: fakeFetch("0.9.0"),
      now: 1000,
      optOut: undefined,
    });
    const cache = JSON.parse(fs.readFileSync(path.join(tmpBase, ".update-check.json"), "utf8"));
    expect(cache.latest).toBe("0.9.0");
    expect(cache.checkedAt).toBe(1000);
  });

  it("신선한 캐시가 있으면 네트워크를 치지 않는다", async () => {
    fs.writeFileSync(
      path.join(tmpBase, ".update-check.json"),
      JSON.stringify({ checkedAt: 5000, latest: "0.2.0" }),
    );
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: true,
      fetchImpl: failFetch, // 캐시 신선 → 호출되면 throw 로 실패해야 함(호출 안 됨을 방증)
      now: 6000,
      ttlMs: 100000,
      optOut: undefined,
    });
    expect(notice).toEqual({ current: "0.1.3", latest: "0.2.0" });
  });

  it("opt-out 이면 항상 null", async () => {
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: true,
      fetchImpl: fakeFetch("9.9.9"),
      optOut: "1",
    });
    expect(notice).toBeNull();
  });

  it("네트워크 비허용(비대화형)이고 캐시 없으면 null (지연·잡음 0)", async () => {
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: false,
      fetchImpl: failFetch,
      optOut: undefined,
    });
    expect(notice).toBeNull();
  });

  it("조회 실패(오프라인)는 흡수하고 null", async () => {
    const notice = await checkForUpdate({
      base: tmpBase,
      currentVersion: "0.1.3",
      allowNetwork: true,
      fetchImpl: failFetch,
      optOut: undefined,
    });
    expect(notice).toBeNull();
  });
});
