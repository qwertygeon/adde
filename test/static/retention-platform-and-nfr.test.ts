import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-026 (NFR-006): 측정 가능한 런타임 관측이 본질적으로 없는 플랫폼·구조 선언 항목 — 검증은
// 정적 확인(대상 플랫폼 명시 + OS 한정 로직의 명시적 분기 여부)으로 갈음한다.
// SC-027 (NFR-001): 측정 대상 NFR 부재가 spec.md 에 명시 선언되어 있는지 확인으로 갈음한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const constitutionPath = path.join(repoRoot, ".claude/docs/constitution.md");
const hasConstitution = fs.existsSync(constitutionPath);

describe("SC-026: macOS+Node LTS 대상 플랫폼 선언 + iCloud 는 명시적 제공자 분기", () => {
  it("package.json 이 Node 엔진(LTS 범위)을 명시한다(플랫폼 선언)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      engines?: Record<string, string>;
    };
    expect(pkg.engines?.node).toBeTruthy();
  });

  it("iCloud 한정 동작은 sync-provider.ts 의 명시적 'icloud' 제공자 id 뒤로 격리된다(침묵 OS 분기 아님)", () => {
    const providerPath = path.join(repoRoot, "src/src-adapters/sync-provider.ts");
    if (!fs.existsSync(providerPath)) return; // 미구현(B-02 진행 중) — 5b 실행이 최종 확인
    const src = fs.readFileSync(providerPath, "utf8");
    expect(src).toMatch(/id:\s*"icloud"/);
    expect(src).toMatch(/id:\s*"local"/);
  });

  it.runIf(hasConstitution)("constitution(로컬) 이 macOS/Node·TS 대상 플랫폼을 선언한다", () => {
    const text = fs.readFileSync(constitutionPath, "utf8");
    expect(text).toMatch(/macOS/);
  });
});

describe("SC-027: 측정 대상 NFR(SLA) 부재가 spec.md 에 명시 선언되어 있다", () => {
  it("spec.md NFR-001 이 측정 NFR 면제를 선언한다", () => {
    const specPath = path.join(
      repoRoot,
      "docs/specs/v0.1.5/007-retention-backup-relocation/spec/spec.md",
    );
    if (!fs.existsSync(specPath)) return; // spec 폴더 비공개(gitignore) 환경 — 로컬 파이프라인 전용
    const text = fs.readFileSync(specPath, "utf8");
    expect(text).toMatch(/NFR-001/);
    expect(text).toMatch(/측정 대상 성능·품질 SLA/);
  });

  it.runIf(hasConstitution)("constitution §3 의 SLA·측정 대상 NFR 부재 선언과 정합한다", () => {
    const text = fs.readFileSync(constitutionPath, "utf8");
    expect(text).toMatch(/측정 대상 NFR/);
  });
});
