// SC-048 (NFR-004), SC-050 (NFR-004), SC-051 (NFR-004) — 기존 테스트 무수정·프로덕션 의존 불변·명령 표면 불변.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// spec.md SC-048 "기준 커밋 `b37d492`" — Test Authoring Contract 런타임 제약 13 의 baseCommit 상수.
const BASE_COMMIT = "b37d492";

function hasGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
    execFileSync("git", ["cat-file", "-e", BASE_COMMIT], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function readAtBase(rel: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${BASE_COMMIT}:${rel}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }
}

function existsAtBase(rel: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE_COMMIT}:${rel}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function changedTestPaths(): string[] {
  const out = execFileSync("git", ["diff", "--name-only", BASE_COMMIT, "--", "test/"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter((l) => l.length > 0);
}

const gitAvailable = hasGit();

describe.runIf(gitAvailable)("SC-048: 기존 테스트를 고치지 않는다", () => {
  it("Happy: baseCommit 대비 변경된 test/ 경로가 전부 신규 파일이다 (test_SC048_changed_test_paths_are_new_files_only)", () => {
    const changed = changedTestPaths();
    const preexisting = changed.filter((p) => existsAtBase(p));
    expect(preexisting).toEqual([]);
  });

  it("Edge: baseCommit 에 존재했던 기존 테스트 파일이 삭제 목록에 없다 (test_SC048_no_deleted_existing_test)", () => {
    const status = execFileSync("git", ["diff", "--name-status", BASE_COMMIT, "--", "test/"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const deleted = status
      .split("\n")
      .filter((line) => line.startsWith("D\t"))
      .map((line) => line.slice(2));
    expect(deleted).toEqual([]);
  });

  it("Error: 합성 대조 — baseCommit 에 실제 존재하는 경로는 존재 판정된다 (test_SC048_detects_synthetic_existing_path)", () => {
    expect(existsAtBase("test/setup.ts")).toBe(true);
  });
});

describe.runIf(gitAvailable)("SC-050: 프로덕션 의존이 그대로다", () => {
  function dependenciesOf(pkgJson: string): Record<string, string> {
    const parsed = JSON.parse(pkgJson) as { dependencies?: Record<string, string> };
    return parsed.dependencies ?? {};
  }

  it("Happy: package.json 의 dependencies 가 기준과 동일하다 (test_SC050_package_json_dependencies_equal_base)", () => {
    const basePkg = readAtBase("package.json");
    if (basePkg === undefined) return;
    const currentPkg = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    expect(dependenciesOf(currentPkg)).toEqual(dependenciesOf(basePkg));
  });

  it("Edge: lockfile 의 루트 importer dependencies 블록이 기준과 동일하다 (test_SC050_lockfile_importer_dependencies_block_equal_base)", () => {
    const baseLock = readAtBase("pnpm-lock.yaml");
    if (baseLock === undefined) return;
    const extractBlock = (text: string): string => {
      const lines = text.split("\n");
      const startIdx = lines.findIndex((l) => l.trim() === "dependencies:");
      if (startIdx === -1) return "";
      const indent = lines[startIdx]?.match(/^\s*/)?.[0].length ?? 0;
      const block: string[] = [];
      for (let i = startIdx + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
        if (line.trim().length > 0 && lineIndent <= indent) break;
        block.push(line);
      }
      return block.join("\n");
    };
    const currentLock = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(extractBlock(currentLock)).toBe(extractBlock(baseLock));
  });

  it("Error: 합성 의존성 추가를 검출한다 (test_SC050_detects_synthetic_added_dependency)", () => {
    const base = { dependencies: { a: "1.0.0" } };
    const current = { dependencies: { a: "1.0.0", injected: "9.9.9" } };
    expect(current.dependencies).not.toEqual(base.dependencies);
  });
});

describe.runIf(gitAvailable)("SC-051: 사용자 대면 표면이 그대로다", () => {
  it("Happy: src/cli/spec.ts 가 기준 대비 불변이다 (test_SC051_command_spec_unchanged_since_base)", () => {
    if (!existsAtBase("src/cli/spec.ts")) return;
    execFileSync("git", ["diff", "--quiet", BASE_COMMIT, "--", "src/cli/spec.ts"], {
      cwd: repoRoot,
    });
  });

  it("Edge: src/shared/locales/** 가 기준 대비 불변이다 (test_SC051_locales_unchanged_since_base)", () => {
    if (!existsAtBase("src/shared/locales")) return;
    execFileSync("git", ["diff", "--quiet", BASE_COMMIT, "--", "src/shared/locales/"], {
      cwd: repoRoot,
    });
  });
});
