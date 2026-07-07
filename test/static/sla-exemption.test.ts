import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-013 (NFR-006 관련 — SLA 면제 선언): 측정 가능한 수용 예시가 본질적으로 부재한 SC.
// constitution.md §3 의 "SLA·측정 대상 NFR 없음(개발자용 로컬 CLI)" 선언 존재 확인으로 검증을 갈음한다.
//
// constitution.md 는 .claude/docs/(비공개, git 비추적 — 프로젝트 CLAUDE.md "공개/비공개 구조")
// 소재라 공개 CI 체크아웃에는 존재하지 않는다. 파일이 있을 때(로컬 파이프라인 실행)만 실 검증하고,
// 없으면(공개 CI) skip 한다 — no-op 통과가 아니라 vitest 가 명시적으로 "skipped" 로 구분 보고한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const constitutionPath = path.join(repoRoot, ".claude/docs/constitution.md");
const hasConstitution = fs.existsSync(constitutionPath);

describe.runIf(hasConstitution)("SC-013: constitution.md SLA 면제 선언(로컬 — 비공개 문서)", () => {
  it("constitution §3 에 SLA·측정 대상 NFR 부재 선언이 명시되어 있다", () => {
    const text = fs.readFileSync(constitutionPath, "utf8");
    expect(text).toMatch(/SLA/);
    expect(text).toMatch(/측정 대상 NFR/);
  });
});

describe("SC-013: 공개 표면에 측정형 SLA 게이트가 없다(개발자용 로컬 CLI 정합)", () => {
  it("package.json 에 가동률·SLA 등 측정 서비스 수준 선언이 없다", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      description?: string;
    };
    expect(pkg.description ?? "").not.toMatch(/\bSLA\b|uptime|99\.\d+%/i);
  });
});
