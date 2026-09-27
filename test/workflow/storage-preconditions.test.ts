import { describe, expect, it } from "vitest";

// 001-phase0-baseline-storage-spike — 전제조건 체크 단위 검증(T035).
// src/workflow/storage-preconditions.ts 의 checkStoragePreconditions() 를 importSqlite·
// nodeVersion 주입으로 4분기 전건 판정한다. 레이어 B 미착지 시점의 import 오류는 예상 RED
// (PROC-R15) — 테스트별 동적 import 로 격리한다.

async function importPreconditions() {
  return import("../../src/workflow/storage-preconditions.js");
}

describe("SC-022: 모듈 부재 시 전제조건 체크가 실패로 판정한다", () => {
  it("Happy: importSqlite 가 일반 오류로 reject 하면 프로세스 미중단 + ok:false + module_absent", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.reject(new Error("Cannot find module 'node:sqlite'")),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("module_absent");
    }
  });

  it("Edge: 오류 메시지에 --experimental-sqlite 가 포함되면 module_behind_flag 로 구분된다", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () =>
        Promise.reject(
          new Error("node:sqlite requires the --experimental-sqlite command-line flag"),
        ),
      nodeVersion: "22.6.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("module_behind_flag");
    }
  });

  it("Error: importSqlite 가 동기 throw 를 해도 반환값(promise reject 아님)으로 수렴한다", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    await expect(
      checkStoragePreconditions({
        importSqlite: () => {
          throw new Error("synchronous boom");
        },
        nodeVersion: "24.18.0",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("SC-023: 라이브러리 버전 미달 시 전제조건 체크가 실패로 판정한다", () => {
  function fakeSqliteModule(version: string) {
    class FakeDatabaseSync {
      constructor(_path: string, _opts?: { timeout?: number }) {
        void _path;
        void _opts;
      }
      prepare(sql: string) {
        return {
          get: () => (sql.includes("sqlite_version") ? { v: version } : undefined),
        };
      }
      close() {
        /* no-op */
      }
    }
    return { DatabaseSync: FakeDatabaseSync };
  }

  it("Happy: 하한 미달 버전 보고 시 library_version_below_floor + detectedSqliteLibraryVersion 동봉", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(fakeSqliteModule("3.40.0")),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("library_version_below_floor");
      expect(result.detectedSqliteLibraryVersion).toBe("3.40.0");
    }
  });

  it("Edge: 하한과 정확히 같은 버전은 통과한다", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(fakeSqliteModule("3.51.3")),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(true);
  });

  it("Error: 버전 문자열이 비파싱값이면 indeterminate 로 수렴한다", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(fakeSqliteModule("not-a-version")),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("indeterminate");
    }
  });
});

describe("SC-037: 완료되지 못한 검사가 실패로 취급된다", () => {
  it("Happy: 체크가 판정에 도달하지 못하는 예외 주입 시 ok:false + indeterminate", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve({ DatabaseSync: null as unknown }),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("indeterminate");
    }
  });

  it("Edge: ②(같은 가드 블록의 버전 판독) 단계에서 비-Error 값을 throw 해도 indeterminate 로 수렴한다", async () => {
    // ①(importSqlite 실패)은 성공/실패 여부와 무관하게 항상 module_absent|module_behind_flag 로
    // 수렴한다(design.md 계약 규칙 2) — indeterminate 는 ①을 통과한 뒤(②·③)의 예상 밖 예외
    // 전용이다. 그 판별 지점을 재현하려면 모듈 획득은 성공시키고 버전 판독에서 비-Error 를
    // throw 하는 가짜 SqliteModule 을 주입한다.
    const { checkStoragePreconditions } = await importPreconditions();
    class ThrowingDatabaseSync {
      constructor(_path: string, _opts?: { timeout?: number }) {
        void _path;
        void _opts;
      }
      prepare(_sql: string) {
        void _sql;
        return {
          get: () => {
            // 비-Error 값을 의도적으로 throw 하여 ③(그 외 예외) 분기를 재현한다.
            throw "non-error-value-during-version-read";
          },
        };
      }
      close() {
        /* no-op */
      }
    }
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve({ DatabaseSync: ThrowingDatabaseSync }),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("indeterminate");
    }
  });

  it("Error: 판정 불가를 성공으로 반환하는 구현이 있다면 이 어서션이 그것을 잡는다", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.reject(new Error("boom")),
      nodeVersion: "24.18.0",
    });
    // 어떤 실패 경로에서도 ok:true 가 나와서는 안 된다 — 부분 성공 금지(NFR-005).
    expect(result.ok).toBe(false);
  });
});

// 002-storage-precondition-close-guard — 검사 연결 close 실패·문자열 변환 불가 예외의 무예외 수렴.
// 가짜 close 예외는 실측 형태(ERR_INVALID_STATE "database is not open")를 재현한다.

interface ProbeOptions {
  readonly version?: string;
  readonly versionReadThrows?: unknown;
  readonly closeThrows?: boolean;
}

function probeSqliteModule(opts: ProbeOptions) {
  const calls = { close: 0 };
  class ProbeDatabaseSync {
    constructor(_path: string, _opts?: { timeout?: number }) {
      void _path;
      void _opts;
    }
    prepare(_sql: string) {
      void _sql;
      return {
        get: () => {
          if (opts.versionReadThrows !== undefined) throw opts.versionReadThrows;
          return { v: opts.version ?? "3.51.3" };
        },
      };
    }
    close() {
      calls.close += 1;
      if (opts.closeThrows) {
        throw Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
      }
    }
  }
  return { module: { DatabaseSync: ProbeDatabaseSync }, calls };
}

describe("002 SC-001: 판정 성공 뒤 close 실패는 indeterminate 로 수렴한다", () => {
  it("Happy: 하한 충족 + close throw → resolve, ok:false, indeterminate, detail 에 close 사유", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const probe = probeSqliteModule({ version: "3.51.3", closeThrows: true });
    const pending = checkStoragePreconditions({
      importSqlite: () => Promise.resolve(probe.module),
      nodeVersion: "24.18.0",
    });
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "indeterminate" });
    const result = await pending;
    if (!result.ok) {
      expect(result.detail).toContain("database is not open");
      expect(result.detectedSqliteLibraryVersion).toBe("3.51.3");
    }
  });
});

describe("002 SC-002: 이미 실패인 판정은 close 실패에 가려지지 않는다", () => {
  it("Edge: 하한 미달 + close throw → library_version_below_floor 유지", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const probe = probeSqliteModule({ version: "3.40.0", closeThrows: true });
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(probe.module),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("library_version_below_floor");
      expect(result.detectedSqliteLibraryVersion).toBe("3.40.0");
    }
  });

  it("Error: 버전 판독 throw + close throw → indeterminate, detail 은 1차 예외 메시지", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const probe = probeSqliteModule({
      versionReadThrows: new Error("version read failed"),
      closeThrows: true,
    });
    const result = await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(probe.module),
      nodeVersion: "24.18.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("indeterminate");
      expect(result.detail).toContain("version read failed");
      expect(result.detail).not.toContain("database is not open");
    }
  });
});

describe("002 SC-003: 문자열로 변환할 수 없는 예외 값도 결과 객체로 수렴한다", () => {
  it("Edge: 버전 판독 단계에서 프로토타입 없는 객체를 throw → resolve ok:false", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    const probe = probeSqliteModule({ versionReadThrows: Object.create(null) as unknown });
    await expect(
      checkStoragePreconditions({
        importSqlite: () => Promise.resolve(probe.module),
        nodeVersion: "24.18.0",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "indeterminate" });
  });

  it("Error: 모듈 획득 단계에서 프로토타입 없는 객체로 reject → resolve ok:false", async () => {
    const { checkStoragePreconditions } = await importPreconditions();
    await expect(
      checkStoragePreconditions({
        importSqlite: () => Promise.reject(Object.create(null) as unknown),
        nodeVersion: "24.18.0",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "module_absent" });
  });
});

describe("002 SC-004: 연결이 열린 모든 경로에서 close 를 정확히 1회 시도한다", () => {
  const cases: ReadonlyArray<[string, ProbeOptions]> = [
    ["성공 판정", { version: "3.51.3" }],
    ["하한 미달", { version: "3.40.0" }],
    ["버전 판독 예외", { versionReadThrows: new Error("boom") }],
    ["close 예외", { version: "3.51.3", closeThrows: true }],
  ];
  it.each(cases)("Happy: %s 경로에서 close 호출 1회", async (_label, opts) => {
    const { checkStoragePreconditions } = await importPreconditions();
    const probe = probeSqliteModule(opts);
    await checkStoragePreconditions({
      importSqlite: () => Promise.resolve(probe.module),
      nodeVersion: "24.18.0",
    });
    expect(probe.calls.close).toBe(1);
  });
});
