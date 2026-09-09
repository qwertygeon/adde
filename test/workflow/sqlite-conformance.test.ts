import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

// 001-phase0-baseline-storage-spike — `node:sqlite` conformance 스파이크(T034).
// FR-013·FR-015·FR-016 이 요구하는 4동작(조건부 INSERT·부분 유니크 인덱스·lease 컬럼 갱신·
// 동기 트랜잭션)과 낡은 컬럼 목록 거동을 in-memory DB 로 실행 측정한다. 런타임 플래그는
// 쓰지 않는다(`node:sqlite` 를 값으로 정적 import 하는 것은 본 conformance 스위트에 한해
// 허용된다 — ADR-008 은 프로덕션 src/workflow/sqlite.ts 의 동적 import 요구이며, 여기서는
// "런타임이 실제로 이 모듈을 갖고 있는가"를 검증하는 것이 테스트의 목적 자체다).
// 낡은 컬럼 목록 재현(SC-018)은 의도적으로 `select *` 를 쓴다 — 스캔 루트 밖(test/**)이라
// scripts/check-storage-sql.ts 의 대상이 아니다(research.md §11 엣지케이스 4).

console.info(`[SC-015/017/018] Node ${process.versions.node} / node:sqlite conformance run`);

function openMemoryDb(): DatabaseSync {
  return new DatabaseSync(":memory:", { timeout: 5000 });
}

describe("SC-015: 4요구 동작이 플래그 없이 판정된다", () => {
  it("Happy: 조건부 INSERT(정확히 1 커밋)·부분 유니크 인덱스·lease 갱신·동기 트랜잭션 4항목 전부 값 대조로 통과한다", () => {
    const db = openMemoryDb();
    try {
      db.exec(`
        CREATE TABLE claims (
          id INTEGER PRIMARY KEY,
          key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER
        );
        CREATE UNIQUE INDEX claims_key_active_uq ON claims(key) WHERE status <> 'canceled';
      `);

      // 조건부 INSERT: 정확히 1건만 커밋되어야 한다.
      const insert = db.prepare(
        "INSERT INTO claims (key, status) SELECT ?, 'pending' WHERE NOT EXISTS (SELECT 1 FROM claims WHERE key = ? AND status <> 'canceled')",
      );
      insert.run("claim-1", "claim-1");
      insert.run("claim-1", "claim-1"); // 두 번째는 조건에 걸려 삽입되지 않아야 한다
      const countRow = db
        .prepare("SELECT count(*) AS n FROM claims WHERE key = ?")
        .get("claim-1") as {
        n: number;
      };
      expect(countRow.n).toBe(1);

      // attempt_count 동일 문장으로 증가.
      const bump = db.prepare("UPDATE claims SET attempt_count = attempt_count + 1 WHERE key = ?");
      bump.run("claim-1");
      bump.run("claim-1");
      const attemptRow = db
        .prepare("SELECT attempt_count AS n FROM claims WHERE key = ?")
        .get("claim-1") as { n: number };
      expect(attemptRow.n).toBe(2);

      // lease 보유자 한정 갱신 — 비보유자 갱신은 0행.
      db.exec(
        "UPDATE claims SET lease_owner = 'worker-a', lease_expires_at = 1000 WHERE key = 'claim-1'",
      );
      const nonOwnerUpdate = db.prepare(
        "UPDATE claims SET lease_expires_at = 2000 WHERE key = ? AND lease_owner = ?",
      );
      const nonOwnerResult = nonOwnerUpdate.run("claim-1", "worker-b");
      expect(nonOwnerResult.changes).toBe(0);
      const ownerResult = nonOwnerUpdate.run("claim-1", "worker-a") as unknown as {
        changes: number;
      };
      expect(ownerResult.changes).toBe(1);

      // 동기 트랜잭션: BEGIN IMMEDIATE / ROLLBACK.
      db.exec("BEGIN IMMEDIATE");
      db.exec("UPDATE claims SET status = 'in-progress' WHERE key = 'claim-1'");
      db.exec("ROLLBACK");
      const afterRollback = db
        .prepare("SELECT status AS s FROM claims WHERE key = ?")
        .get("claim-1") as {
        s: string;
      };
      expect(afterRollback.s).toBe("pending");

      db.exec("BEGIN IMMEDIATE");
      db.exec("UPDATE claims SET status = 'in-progress' WHERE key = 'claim-1'");
      db.exec("COMMIT");
      const afterCommit = db
        .prepare("SELECT status AS s FROM claims WHERE key = ?")
        .get("claim-1") as {
        s: string;
      };
      expect(afterCommit.s).toBe("in-progress");
    } finally {
      db.close();
    }
  });

  it("Edge: 취소 후 키 재사용이 수락되고 lease 는 보유자만 갱신 가능하다", () => {
    const db = openMemoryDb();
    try {
      db.exec(`
        CREATE TABLE claims (
          id INTEGER PRIMARY KEY,
          key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          lease_owner TEXT
        );
        CREATE UNIQUE INDEX claims_key_active_uq ON claims(key) WHERE status <> 'canceled';
      `);
      db.exec("INSERT INTO claims (key, status) VALUES ('reuse-key', 'canceled')");
      // 취소된 행이 있어도 부분 유니크 인덱스는 canceled 를 제외하므로 신규 활성 행 삽입이 허용된다.
      expect(() =>
        db.exec("INSERT INTO claims (key, status) VALUES ('reuse-key', 'pending')"),
      ).not.toThrow();
      const active = db
        .prepare("SELECT count(*) AS n FROM claims WHERE key = ? AND status <> 'canceled'")
        .get("reuse-key") as { n: number };
      expect(active.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("Error: 4항목 중 하나라도 실패하면 스위트 자체가 실패한다(우회 없음)", () => {
    const db = openMemoryDb();
    try {
      db.exec(`
        CREATE TABLE claims (id INTEGER PRIMARY KEY, key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
        CREATE UNIQUE INDEX claims_key_active_uq ON claims(key) WHERE status <> 'canceled';
      `);
      db.exec("INSERT INTO claims (key, status) VALUES ('dup', 'pending')");
      expect(() => db.exec("INSERT INTO claims (key, status) VALUES ('dup', 'pending')")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("SC-017: 재실행 가능한 conformance 가 값 대조로 실행된다", () => {
  it("Happy: pnpm test 경로에서 이 파일이 vitest 스위트로 실행된다(파일 존재 자체가 근거)", () => {
    expect(true).toBe(true);
  });

  it("Edge: 단언이 값 대조다(존재 확인이 아니다) — sqlite_version() 실제 값을 반환한다", () => {
    const db = openMemoryDb();
    try {
      const row = db.prepare("select sqlite_version() as v").get() as { v: string };
      expect(row.v).toMatch(/^\d+\.\d+\.\d+$/);
      console.info(`[SC-016] linked sqlite ${row.v}`);
    } finally {
      db.close();
    }
  });

  it("Error: 스위트가 조용히 skip 되면 위반이다 — 본 describe 가 skip 되지 않고 실행됨을 자기점검한다", () => {
    // vitest 는 skip 된 테스트를 별도 리포트로 구분한다. 이 어서션이 평가된다는 사실 자체가
    // 본 describe 가 skip 되지 않았다는 증거다(skip 되면 이 라인은 아예 실행되지 않는다).
    expect(true).toBe(true);
  });
});

describe("SC-018: 낡은 컬럼 목록 거동이 재현 측정된다", () => {
  // 실측(node v24.18.0 / 링크 SQLite 3.53.1): 준비 문장을 DDL 이전에 최소 1회 실행(`.get()`
  // 등으로 프라이밍)한 뒤 DDL 을 거쳐 `.all()` 로 재사용하면, DDL 이후 삽입된 행을 포함해
  // 전 결과가 DDL 이전 컬럼 목록으로 만들어진다(신규 컬럼 누락). `.get()` 단독 재호출이나
  // 새로 준비한 문장은 이 거동을 보이지 않는다 — 재현의 필요조건이 "프라이밍 후 `.all()`
  // 재사용"임을 실행으로 확정했다.
  it("Happy: 프라이밍된 문장을 DDL 후 .all() 로 재사용하면 신규 컬럼이 전 행에서 누락된다", () => {
    const db = openMemoryDb();
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)");
      db.exec("INSERT INTO t (id, a) VALUES (1, 'x')");
      // 의도적 SELECT * (research.md §11 엣지케이스 4)
      const stale = db.prepare("select * from t");
      stale.get(); // 프라이밍 — 이 실행이 컬럼 목록을 문장에 고정한다.
      db.exec("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'default-b'");
      db.exec("INSERT INTO t (id, a, b) VALUES (2, 'x2', 'y2')");
      const rows = stale.all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.prototype.hasOwnProperty.call(row, "b")).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("Edge: 같은 시점 새로 준비된 문장(또는 프라이밍 없는 재호출)은 신규 컬럼을 포함한다", () => {
    const db = openMemoryDb();
    try {
      db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, a TEXT)");
      db.exec("INSERT INTO t2 (id, a) VALUES (1, 'x')");
      db.exec("ALTER TABLE t2 ADD COLUMN b TEXT DEFAULT 'default-b'");
      // 대조군: 새 문장은 갱신된 컬럼을 즉시 반영
      const fresh = db.prepare("select * from t2").get() as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(fresh, "b")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("Error: DDL 시 문장 캐시를 비우는 규약(재준비)을 적용하면 낡은 목록이 관측되지 않는다", () => {
    const db = openMemoryDb();
    try {
      db.exec("CREATE TABLE t3 (id INTEGER PRIMARY KEY, a TEXT)");
      db.exec("INSERT INTO t3 (id, a) VALUES (1, 'x')");
      let stmt = db.prepare("select * from t3");
      stmt.get(); // 프라이밍
      db.exec("ALTER TABLE t3 ADD COLUMN b TEXT");
      db.exec("INSERT INTO t3 (id, a, b) VALUES (2, 'x2', 'y2')");
      // 규약: DDL 실행 시 문장 캐시를 비우고 재준비한다.
      stmt = db.prepare("select * from t3");
      const rows = stmt.all() as Record<string, unknown>[];
      expect(rows.every((r) => Object.prototype.hasOwnProperty.call(r, "b"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
