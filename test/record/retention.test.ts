import { describe, expect, it } from "vitest";
import * as path from "node:path";

// 확정 시그니처: RetentionPolicy{backupDir,retentionDays,now} · isArchivedTurn(policy, iso) ·
// backupTargetPath(backupDir, vaultRelPath, turnStartIso) ·
// assertBackupNotOverlapping(backupDir, vaultRoot, configRoot, cwd) — 겹치면 throw.

describe("isArchivedTurn — 순수 판정 함수(ADR-023b 공유 판정)", () => {
  it("Happy: 보관 일수보다 오래된 턴은 archived 로 판정된다", async () => {
    const retention = await import("../../src/record/retention.js");
    const now = () => new Date("2026-08-26T00:00:00.000Z");
    const policy = { backupDir: "/tmp/backup", retentionDays: 2, now };
    expect(retention.isArchivedTurn(policy, "2026-08-20T00:00:00.000Z")).toBe(true);
  });

  it("Edge: 정확히 cutoff 경계인 턴은 strict `<` 규약에 따라 아직 archived 가 아니다", async () => {
    const retention = await import("../../src/record/retention.js");
    const now = () => new Date("2026-08-26T00:00:00.000Z");
    const policy = { backupDir: "/tmp/backup", retentionDays: 2, now };
    const cutoffIso = "2026-08-24T00:00:00.000Z"; // now - 2일 정확히
    expect(retention.isArchivedTurn(policy, cutoffIso)).toBe(false);
  });

  it("Error: backupDir 이 null(비활성)이면 어떤 턴도 archived 로 판정하지 않는다", async () => {
    const retention = await import("../../src/record/retention.js");
    const now = () => new Date("2026-08-26T00:00:00.000Z");
    const policy = { backupDir: null, retentionDays: 2, now };
    expect(retention.isArchivedTurn(policy, "2020-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("backupTargetPath — 턴 시작 날짜 폴더로 목적지 산출(DEC-005)", () => {
  it("Happy: 목적지가 `<backup>/<턴 시작 날짜>/<vault 상대경로>` 형식이다", async () => {
    const retention = await import("../../src/record/retention.js");
    const target = retention.backupTargetPath(
      "/backup",
      path.join("projects", "p1", "sessions", "s1", "turns", "0001 x.md"),
      "2026-08-20T10:00:00.000Z",
    );
    expect(target).toContain(`${path.sep}2026-08-20${path.sep}`);
    expect(target).toContain(path.join("sessions", "s1", "turns"));
  });

  it("Edge: 이관 실행일과 턴 시작일이 다르면 턴 시작일 폴더로 귀결한다(재렌더 멱등)", async () => {
    const retention = await import("../../src/record/retention.js");
    const t1 = retention.backupTargetPath("/backup", "a/b.md", "2026-01-01T00:00:00.000Z");
    const t2 = retention.backupTargetPath("/backup", "a/b.md", "2026-01-01T23:59:59.000Z");
    expect(t1).toBe(t2); // 같은 날짜(UTC/local 경계 이슈는 Development 구현이 결정)
  });
});

describe("SC-046: 겹치는 보관 위치가 거부된다", () => {
  it("Happy: vault·설정 루트·프로젝트 실행 경로 하위 3종 모두 거부된다", async () => {
    const retention = await import("../../src/record/retention.js");
    const vaultRoot = "/tmp/vault";
    const configRoot = "/tmp/config";
    const cwd = "/tmp/cwd";
    expect(() =>
      retention.assertBackupNotOverlapping(path.join(vaultRoot, "sub"), vaultRoot, configRoot, cwd),
    ).toThrow();
    expect(() =>
      retention.assertBackupNotOverlapping(
        path.join(configRoot, "sub"),
        vaultRoot,
        configRoot,
        cwd,
      ),
    ).toThrow();
    expect(() =>
      retention.assertBackupNotOverlapping(path.join(cwd, "sub"), vaultRoot, configRoot, cwd),
    ).toThrow();
  });

  it("Edge: 대소문자만 다른 경로도 거부된다(normCasePath, CV-4)", async () => {
    const retention = await import("../../src/record/retention.js");
    const vaultRoot = "/tmp/Vault";
    expect(() =>
      retention.assertBackupNotOverlapping("/tmp/vault/sub", vaultRoot, "/tmp/config", "/tmp/cwd"),
    ).toThrow();
  });

  it("Error: 존재하지 않는 상위 경로를 지정해도 겹치지 않으면 거부되지 않는다(생성은 별개 책임)", async () => {
    const retention = await import("../../src/record/retention.js");
    expect(() =>
      retention.assertBackupNotOverlapping(
        "/tmp/does-not-exist-backup",
        "/tmp/vault",
        "/tmp/config",
        "/tmp/cwd",
      ),
    ).not.toThrow();
  });
});
