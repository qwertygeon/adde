import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-016·SC-021·SC-023 (정적 — [env:static]): restart exit code behavior-change·status --json
// BREAKING/마이그레이션 안내·ADDE_UP_POLL_MS 문서화. 산출 주체는 6단계 Docs Agent(tasks.md T014) —
// 5b(6단계 이전) 시점에는 미산출로 RED 가 예상 상태다(PROC-R15). main 이 6단계 완료 후 재확인한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");

describe("restart exit code 변경 behavior-change 기재 (SC-016)", () => {
  it("CHANGELOG 에 restart 종료 코드 변경(항상 0 → 실패 시 1)이 기재되어 있다", () => {
    // "restart" 언급과 "종료 코드 변경" 언급이 서로 무관한 별개 문장에 각각 존재해도 우연히
    // 통과하지 않도록, 같은 줄(=같은 changelog 항목)에 restart·종료코드/exit code·숫자 1 이
    // 함께 있는지로 판정한다(전역 OR 매칭의 거짓양성 방지).
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /restart/i.test(line) && /(종료\s*코드|exit\s*code)/i.test(line) && /\b1\b/.test(line),
      );
    expect(hasCombinedLine, "restart 종료 코드 변경 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("status --json BREAKING + 마이그레이션 안내 (SC-021)", () => {
  it("CHANGELOG 에 status --json BREAKING 표기와 `.` → `.lanes` 마이그레이션 안내가 기재되어 있다", () => {
    // BREAKING 표기 자체는 다른 항목(예: conf 키 네임스페이스화)에도 이미 존재하므로, status·--json·
    // BREAKING·.lanes 가 같은 항목(줄)에 함께 있는지로 판정해 무관 항목의 거짓양성을 막는다.
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /status/i.test(line) && /--json/.test(line) && /BREAKING/.test(line) && /\.lanes/.test(line),
      );
    expect(hasCombinedLine, "status --json BREAKING + .lanes 마이그레이션 기재 항목을 찾을 수 없음").toBe(
      true,
    );
  });
});

describe("ADDE_UP_POLL_MS 문서화 (SC-023)", () => {
  it("도움말 또는 프로젝트 문서에 env 명·의미(폴링 상한 ms·양수만 유효·기본 8000)가 기재되어 있다", () => {
    const docsDir = path.join(repoRoot, "docs");
    const candidates = ["commands.md", "commands.ko.md"].map((f) => path.join(docsDir, f));
    const hits = candidates.filter(
      (f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("ADDE_UP_POLL_MS"),
    );
    expect(hits.length, "ADDE_UP_POLL_MS 를 언급하는 문서가 없음").toBeGreaterThan(0);
    const combined = hits.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(combined).toMatch(/8000/); // 기본값 명시
    expect(combined).toMatch(/양수|positive/i); // 양수만 유효 명시
  });
});
