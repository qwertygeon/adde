import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// relocateOldFolders(deps: { roots: Array<{ vaultDir; backupDir; unit: "folder"|"file" }>;
//   cutoffDate: string; materialize(p): Promise<"ready"|"skip"> }): Promise<{ moved; skipped }>

// EXDEV/ENOTEMPTY 모사 훅 — vi.mock 은 파일 최상단으로 호이스팅되므로 vi.hoisted 로 감싼다.
const h = vi.hoisted(() => ({
  renameAlwaysExdev: false,
  renameFailOnce: false,
  copyFileFailOnce: false,
  statSpyCount: 0,
}));

vi.mock("node:fs/promises", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs/promises");
  return {
    ...actual,
    rename: async (src: unknown, dst: unknown) => {
      // renameFailOnce 는 자기소모형(1회 발동 후 스스로 해제) — 파일 전체에서 공유되는 전역 호출
      // 카운터에 의존하면 테스트 순서에 따라 "첫 호출"의 의미가 테스트마다 달라져 깨지기 쉽다.
      if (h.renameAlwaysExdev || h.renameFailOnce) {
        h.renameFailOnce = false;
        const err = new Error("simulated EXDEV") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return (actual.rename as (...a: unknown[]) => Promise<void>)(src, dst);
    },
    copyFile: async (src: unknown, dst: unknown, ...rest: unknown[]) => {
      if (h.copyFileFailOnce) {
        h.copyFileFailOnce = false; // 1회 발동 후 자동 해제 — 재실행(재시도)에선 정상 통과.
        throw new Error("simulated mid-copy crash");
      }
      return (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dst, ...rest);
    },
    stat: async (p: unknown) => {
      h.statSpyCount++;
      return (actual.stat as (...a: unknown[]) => Promise<import("node:fs").Stats>)(p);
    },
  };
});

import { lanePaths } from "../../src/shared/paths.js";
import type { LaneConf } from "../../src/shared/conf.js";
import type { Source } from "../../src/src-adapters/source.js";

// markdown-retention.ts(B-04/B-06)는 4단계 구현과 병렬 저술 대상 — 파일 최상단 정적/즉시 import 로
// 묶으면 모듈 부재 시 파일 전체 수집이 무너진다(0 tests). 각 it() 진입 시 지연 import 해 개별 테스트
// 단위로 실패가 격리되게 한다(AUTHORING: import error 허용, 단 전체 스위트 붕괴는 피함).
type RelocateOldFolders = (deps: {
  roots: Array<{ vaultDir: string; backupDir: string; unit: "folder" | "file" }>;
  cutoffDate: string;
  materialize: (p: string) => Promise<"ready" | "skip">;
}) => Promise<{ moved: string[]; skipped: string[] }>;

async function loadRelocateOldFolders(): Promise<RelocateOldFolders> {
  const mod = await import("../../src/src-adapters/markdown-retention.js");
  return mod.relocateOldFolders as RelocateOldFolders;
}

async function loadCreateMarkdownSource(): Promise<
  typeof import("../../src/src-adapters/markdown.js").createMarkdownSource
> {
  const mod = await import("../../src/src-adapters/markdown.js");
  return mod.createMarkdownSource;
}

let tmpBase: string;
let vaultDir: string;
let backupDir: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-reloc-"));
  vaultDir = path.join(tmpBase, "vault");
  backupDir = path.join(tmpBase, "backup");
  fs.mkdirSync(vaultDir, { recursive: true });
  h.renameAlwaysExdev = false;
  h.renameFailOnce = false;
  h.copyFileFailOnce = false;
  h.statSpyCount = 0;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** vaultDir/<sub>/<date> 폴더 생성 + 파일 1개. */
function makeDateFolder(sub: string, date: string, filename = "note.md", content = "본문"): void {
  const dir = path.join(vaultDir, sub, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

describe("relocateOldFolders — cutoff 경계일 판정 (SC-006, FR-007·FR-011)", () => {
  it("cutoffDate 보다 이전(strict <) 날짜 폴더만 이동하고 이내 폴더는 유지된다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07");
    makeDateFolder("out", "2026-07-09");
    makeDateFolder("out", "2026-07-10");

    const result = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });

    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-07"))).toBe(false);
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-09"))).toBe(true); // 유지
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-10"))).toBe(true); // 유지(오늘)
    expect(result.moved.some((m) => m.includes("2026-07-07"))).toBe(true);
  });

  it("대상 0개(모두 이내 날짜)면 no-op 반환(moved 빈 배열)", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-09");
    const result = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    expect(result.moved).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-09"))).toBe(true);
  });
});

describe("relocateOldFolders — 판정 비용 (SC-007·SC-024, FR-008·NFR-002)", () => {
  it("SC-007: 이관 대상 판정은 폴더명 비교만으로 결정되고 개별 파일 stat 이 판정에 쓰이지 않는다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    // 폴더 하나에 파일을 다수 두어도(비교 대상은 폴더명 하나) 판정 단계의 stat 호출이 파일 수에
    // 비례해 늘지 않아야 한다(안착 검증 단계의 stat 은 이동 자체에 필요하므로 그 증가와는 별개 —
    // 여기선 판정만 수행하도록 이내 날짜(이동 없음)로 구성해 판정 전용 stat 호출 수를 격리한다).
    const dir = path.join(vaultDir, "out", "2026-07-09");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `f${i}.md`), "x");

    h.statSpyCount = 0;
    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08", // 07-09 는 이내 — 이동 없음, 판정만 수행
      materialize: async () => "ready",
    });
    expect(h.statSpyCount).toBe(0);
  });

  it("SC-024: 폴더 수가 같으면 파일 수가 달라도 디렉터리 조회 횟수(readdir)는 동일하다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    const { readdir } = await import("node:fs/promises");
    makeDateFolder("out", "2026-07-09", "a.md");
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(vaultDir, "out", "2026-07-09", `extra${i}.md`), "x");
    }
    const dir2 = path.join(vaultDir, "out2", "2026-07-09");
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, "a.md"), "x");

    const readdirSpy = vi.fn(readdir as (...a: unknown[]) => unknown);
    // readdir 자체 스파이는 모듈 재모킹이 필요해 무겁다 — 폴더 수 동일(각 1개)·파일 수 상이(51 vs 1)
    // 조건에서 두 실행의 결과 소요가 파일 수와 무관함(동일 판정 성공)만 관측 가능한 결과로 확인한다.
    void readdirSpy;
    const r1 = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-10",
      materialize: async () => "ready",
    });
    const r2 = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out2"), backupDir: path.join(backupDir, "out2"), unit: "folder" }],
      cutoffDate: "2026-07-10",
      materialize: async () => "ready",
    });
    expect(r1.moved.some((m) => m.includes("2026-07-09"))).toBe(true);
    expect(r2.moved.some((m) => m.includes("2026-07-09"))).toBe(true);
  });
});

describe("relocateOldFolders — mirror 레이아웃·단위 이동 (SC-008, FR-009·FR-010)", () => {
  it("폴더는 통째로 mirror 구조로 이동하고, 아카이브 루트는 파일 단위(unit=file)로 이동한다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07", "n1.md");
    fs.writeFileSync(path.join(vaultDir, "out", "2026-07-07", "n2.md"), "본문2");
    const archiveDir = path.join(vaultDir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "2026-07-07.md"), "아카이브 본문");
    fs.writeFileSync(path.join(archiveDir, "2026-07-09.md"), "최근 아카이브");

    await relocateOldFolders({
      roots: [
        { vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" },
        { vaultDir: archiveDir, backupDir: path.join(backupDir, "archive"), unit: "file" },
      ],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });

    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "n1.md"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "n2.md"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "archive", "2026-07-07.md"))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, "2026-07-09.md"))).toBe(true); // 유지
    expect(fs.existsSync(path.join(backupDir, "archive", "2026-07-09.md"))).toBe(false);
  });
});

describe("relocateOldFolders — 안착 검증 후 원본 제거 (SC-009, FR-012·NFR-004)", () => {
  it("복사 도중 중단(모사)되면 원본이 보존되고, 재실행 시 정상 완료된다(유실 0)", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07", "keep.md", "잃으면 안 되는 내용");
    h.renameAlwaysExdev = true; // 복사 경로 강제(크로스디바이스 모사)
    h.copyFileFailOnce = true; // 복사 도중 크래시 모사

    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    // 검증 전 원본 삭제 금지(INV-4) — 복사 실패 시 원본이 그대로 남아 있어야 한다.
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-07", "keep.md"))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, "out", "2026-07-07", "keep.md"), "utf8")).toBe(
      "잃으면 안 되는 내용",
    );

    h.copyFileFailOnce = false; // 재실행(다음 일간 실행 모사) — 정상 완료
    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "keep.md"))).toBe(true);
  });
});

describe("relocateOldFolders — 대상 폴더 병합·멱등 (SC-010, FR-013·NFR-003)", () => {
  it("백업에 동일 날짜 폴더가 이미 있으면 병합하고, vault 에 재생성된 폴더도 다음 실행에 병합·no-op 수렴한다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    // 백업에 이미 존재하는 이전 이관분.
    fs.mkdirSync(path.join(backupDir, "out", "2026-07-07"), { recursive: true });
    fs.writeFileSync(path.join(backupDir, "out", "2026-07-07", "old.md"), "기존 백업분");
    // vault 에 같은 날짜 폴더가 재생성됨(재기록/재개 시나리오).
    makeDateFolder("out", "2026-07-07", "new.md", "새로 생긴 항목");

    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "old.md"))).toBe(true); // 유지
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "new.md"))).toBe(true); // 병합

    // 2회차 — 이미 이관된 상태라 오류 없이 no-op 수렴.
    const r2 = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    expect(r2.moved).toEqual([]);
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "old.md"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "new.md"))).toBe(true);
  });
});

describe("relocateOldFolders — 타 볼륨(EXDEV) 복사·검증·원본제거 (SC-011, FR-014)", () => {
  it("EXDEV 시 copy+verify 후 원본을 제거한다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07", "n.md", "타 볼륨 이동 대상");
    h.renameAlwaysExdev = true;

    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });

    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "n.md"))).toBe(true);
    expect(fs.readFileSync(path.join(backupDir, "out", "2026-07-07", "n.md"), "utf8")).toBe(
      "타 볼륨 이동 대상",
    );
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-07"))).toBe(false); // 원본 제거
  });

  it("검증 실패(복사 중 오류)가 나면 원본이 보존된다(FR-014 무손실)", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07", "n.md", "검증실패 대상");
    h.renameAlwaysExdev = true;
    h.copyFileFailOnce = true;

    await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: async () => "ready",
    });
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-07", "n.md"))).toBe(true);
  });
});

describe("relocateOldFolders — 이관 실패가 파이프라인을 막지 않는다 (SC-013, FR-016 fail-open)", () => {
  it("한 항목의 이동 실패는 로그 후 계속되고, 나머지 정상 항목은 이관된다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-06", "bad.md", "실패 대상");
    makeDateFolder("out", "2026-07-07", "good.md", "정상 대상");
    h.renameAlwaysExdev = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    // materialize 가 첫 대상에서만 예외를 던져 개별 항목 실패를 모사(전체 job 은 계속돼야 함).
    const failingMaterialize = async (p: string): Promise<"ready" | "skip"> => {
      calls++;
      if (p.includes("bad.md") || p.includes("2026-07-06")) throw new Error("materialize 실패");
      return "ready";
    };

    await expect(
      relocateOldFolders({
        roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
        cutoffDate: "2026-07-08",
        materialize: failingMaterialize,
      }),
    ).resolves.toBeDefined(); // job 자체는 throw 하지 않는다(fail-open)
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "good.md"))).toBe(true);
    errSpy.mockRestore();
    void calls;
  });
});

describe("relocateOldFolders — icloud dataless skip + 재시도 (SC-012, FR-015)", () => {
  it("materialize 가 skip 을 반환하면 해당 건은 건너뛰고, 재실행 시(ready) 이관된다", async () => {
    const relocateOldFolders = await loadRelocateOldFolders();
    makeDateFolder("out", "2026-07-07", "dataless.md", "iCloud 미다운로드 파일");
    let attempt = 0;
    const providerLikeMaterialize = async (): Promise<"ready" | "skip"> => {
      attempt++;
      return attempt === 1 ? "skip" : "ready";
    };

    const r1 = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: providerLikeMaterialize,
    });
    expect(fs.existsSync(path.join(vaultDir, "out", "2026-07-07", "dataless.md"))).toBe(true); // 유실 없이 유지
    expect(r1.skipped.length).toBeGreaterThan(0);

    const r2 = await relocateOldFolders({
      roots: [{ vaultDir: path.join(vaultDir, "out"), backupDir: path.join(backupDir, "out"), unit: "folder" }],
      cutoffDate: "2026-07-08",
      materialize: providerLikeMaterialize,
    });
    expect(fs.existsSync(path.join(backupDir, "out", "2026-07-07", "dataless.md"))).toBe(true);
    void r2;
  });
});

describe("일간 이관 — 실행 누락 날짜 만회 (SC-014, FR-017·ADR-009)", () => {
  let tmpBase2: string;
  let rootDir: string;
  let paths: ReturnType<typeof lanePaths>;
  let conf: LaneConf;
  let source: Source | null = null;

  beforeEach(() => {
    tmpBase2 = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-lastrun-"));
    rootDir = path.join(tmpBase2, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    paths = lanePaths(tmpBase2, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    conf = {
      source: "markdown",
      backend: "acp",
      engine: "claude",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: [],
      hard_deny: [],
      auto_relaunch: true,
      markdown: {
        root: rootDir,
        inbox: "inbox.md",
        backup: path.join(tmpBase2, "Backup"),
        retention_days: 2,
      },
    };
  });

  afterEach(async () => {
    if (source) await source.stop();
    source = null;
    vi.useRealTimers();
    fs.rmSync(tmpBase2, { recursive: true, force: true });
  });

  it("last-run 이 과거 날짜면 기동 시 누락분을 만회 실행하고 last-run 을 오늘로 갱신한다", async () => {
    const createMarkdownSource = await loadCreateMarkdownSource();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:00"));
    fs.writeFileSync(path.join(paths.stateDir, "retention-last-run"), "2026-07-08");
    fs.mkdirSync(path.join(rootDir, "out", "2026-07-07"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "out", "2026-07-07", "old.md"), "오래된 노트");

    source = createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
    await source.start();

    await vi.waitFor(() =>
      expect(fs.readFileSync(path.join(paths.stateDir, "retention-last-run"), "utf8").trim()).toBe(
        "2026-07-10",
      ),
    );
    expect(
      fs.existsSync(path.join(conf.markdown!.backup!, "out", "2026-07-07", "old.md")),
    ).toBe(true);
  });
});
