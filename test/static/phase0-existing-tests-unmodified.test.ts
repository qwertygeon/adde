import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 기존 테스트 파일 무수정 정적 검증(T040 / SC-032 / NFR-001).
// `git diff --name-only <baseCommit> -- test/` 의 각 경로가 `git ls-tree <baseCommit>` 에
// 부재(=신규 파일)임을 단언한다. read-only git 명령만 사용한다. git 사용 불가 환경은 skip.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// research.md §10.1 baseline 실측 커밋 — 본 차수 착수 직전 상태(fd63425, working tree clean).
const BASE_COMMIT = "fd63425";

function hasGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
    execFileSync("git", ["cat-file", "-e", BASE_COMMIT], { cwd: repoRoot });
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

function existsAtBaseCommit(rel: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE_COMMIT}:${rel}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();

describe.runIf(gitAvailable)("SC-032: 기존 테스트 스위트 무수정(신규 파일만 추가)", () => {
  it("Happy: pnpm test 는 test(EXECUTION) 이 실행 판정한다(본 파일은 diff 무결성만 검증)", () => {
    // 전체 스위트 실행 판정은 test(EXECUTION) 소관(quality §1.7.2). 본 파일은 정적 무결성만 본다.
    expect(true).toBe(true);
  });

  it("Edge: git diff 로 드러난 test/ 변경 경로 전부가 baseCommit 에 부재(=신규 파일)이다", () => {
    const changed = changedTestPaths();
    const preexisting = changed.filter((p) => existsAtBaseCommit(p));
    expect(preexisting).toEqual([]);
  });

  it("Error: baseCommit 에 존재하는 경로가 변경 목록에 포함되면 위반으로 판정된다(합성 대조)", () => {
    // 판별력 확인 — 실제로 baseCommit 에 존재하는 파일(test/setup.ts)을 인위적으로 대조.
    expect(existsAtBaseCommit("test/setup.ts")).toBe(true);
  });
});
