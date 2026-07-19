import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// migrateFlatToDated(deps: { outboxDir: string; decidedDir: string })
//   : Promise<{ movedOutbox: string[]; movedDecided: string[] }>

function dateFolderFromStamp(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

let tmpBase: string;
let outboxDir: string;
let decidedDir: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-migrate-"));
  outboxDir = path.join(tmpBase, "out");
  decidedDir = path.join(tmpBase, "approvals", ".decided");
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.mkdirSync(decidedDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("migrateFlatToDated — 화이트리스트·멱등 (SC-015, FR-018)", () => {
  it("`<stamp> <id>.md` 형식 2건만 날짜 폴더로 이동하고, 알림·레거시 파일은 원위치 유지, 2회차는 no-op", async () => {
    const { migrateFlatToDated } = await import("../../src/src-adapters/markdown-retention.js");

    const stampA = "20260701-090000";
    const stampB = "20260702-100000";
    fs.writeFileSync(path.join(outboxDir, `${stampA} msg-a.md`), "응답 A");
    fs.writeFileSync(path.join(outboxDir, `${stampB} msg-b.md`), "응답 B");
    fs.writeFileSync(path.join(outboxDir, "_adde-notice.md"), "운영 알림"); // 화이트리스트 제외
    fs.writeFileSync(path.join(outboxDir, "_enqueue-alert.md"), "실패 알림"); // 화이트리스트 제외
    fs.writeFileSync(path.join(outboxDir, "legacy-id.md"), "stamp 없는 레거시"); // 제외(FR-004 폴백과 동형)

    const r1 = await migrateFlatToDated({ outboxDir, decidedDir });

    expect(r1.movedOutbox).toHaveLength(2);
    expect(
      fs.existsSync(path.join(outboxDir, dateFolderFromStamp(stampA), `${stampA} msg-a.md`)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(outboxDir, dateFolderFromStamp(stampB), `${stampB} msg-b.md`)),
    ).toBe(true);
    // 화이트리스트 제외 항목은 top-level 원위치 유지.
    expect(fs.existsSync(path.join(outboxDir, "_adde-notice.md"))).toBe(true);
    expect(fs.existsSync(path.join(outboxDir, "_enqueue-alert.md"))).toBe(true);
    expect(fs.existsSync(path.join(outboxDir, "legacy-id.md"))).toBe(true);
    // 이동된 원본은 top-level 에서 사라짐.
    expect(fs.existsSync(path.join(outboxDir, `${stampA} msg-a.md`))).toBe(false);

    const r2 = await migrateFlatToDated({ outboxDir, decidedDir });
    expect(r2.movedOutbox).toEqual([]); // 2회차 no-op(이미 파티셔닝됨, idempotent)
  });

  it("이미 날짜 폴더 하위에 있는 항목은 건너뛴다(idempotent — 재이동 없음)", async () => {
    const { migrateFlatToDated } = await import("../../src/src-adapters/markdown-retention.js");
    const stamp = "20260703-000000";
    const dateDir = path.join(outboxDir, dateFolderFromStamp(stamp));
    fs.mkdirSync(dateDir, { recursive: true });
    fs.writeFileSync(path.join(dateDir, `${stamp} already-partitioned.md`), "이미 정렬됨");

    const result = await migrateFlatToDated({ outboxDir, decidedDir });
    expect(result.movedOutbox).toEqual([]);
    expect(fs.existsSync(path.join(dateDir, `${stamp} already-partitioned.md`))).toBe(true);
  });
});

describe("최초 활성 마이그레이션 — 단일 아카이브 무파싱 통째 백업 (SC-016, FR-019·ADR-010)", () => {
  let tmpBase2: string;
  let rootDir: string;
  let backupRoot: string;

  beforeEach(() => {
    tmpBase2 = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-archive-hybrid-"));
    rootDir = path.join(tmpBase2, "Notes");
    backupRoot = path.join(tmpBase2, "Backup");
    fs.mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase2, { recursive: true, force: true });
  });

  it("기존 단일 sent-archive.md 파일은 파싱 없이 통째로 백업 이동되고, 이후 신규 기록은 날짜 디렉터리 파일에 쓰인다", async () => {
    const { createMarkdownSource } = await import("../../src/src-adapters/markdown.js");
    const { lanePaths } = await import("../../src/shared/paths.js");
    type LaneConf = import("../../src/shared/conf.js").LaneConf;
    type Source = import("../../src/src-adapters/source.js").Source;

    // 활성화 전 상태 모사: 단일 파일(디렉터리 아님)로 기존 아카이브가 이미 존재.
    fs.writeFileSync(path.join(rootDir, "sent-archive.md"), "## 과거 아카이브 전문\n\n과거 본문\n");
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");

    const paths = lanePaths(tmpBase2, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    const conf: LaneConf = {
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
        archive: "sent-archive.md",
        backup: backupRoot,
        retention_days: 2,
      },
    };

    let source: Source | null = null;
    try {
      source = createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
      await source.start();

      await vi.waitFor(() => {
        // 활성화 후: 기존 경로는 디렉터리로 전환되고(ADR-003), 과거 단일 파일 내용은 백업으로
        // 통째 이동되어 vault 어디에도 파싱된 흔적(분할 파일)이 남지 않는다.
        expect(fs.statSync(path.join(rootDir, "sent-archive.md")).isDirectory()).toBe(true);
      });
      expect(fs.existsSync(path.join(backupRoot, "sent-archive.md"))).toBe(true);
      expect(fs.readFileSync(path.join(backupRoot, "sent-archive.md"), "utf8")).toContain(
        "과거 본문",
      );
    } finally {
      if (source) await source.stop();
    }
  });
});
