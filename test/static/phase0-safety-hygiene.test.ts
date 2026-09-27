import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 환경 격리·시크릿·보호 주장 정적 검증(T038).
// 본 차수 추가 파일 목록에 대해 경로 사용·키 자료·과대 보호 주장을 전수 조회한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// 본 차수(tasks.md T004~T027)가 신규 추가하는 파일 후보 경로. 아직 착지하지 않은 항목은
// existsSync 로 걸러 스킵한다(PPG-1 병렬 — PROC-R15).
const CANDIDATE_NEW_FILES = [
  "policy/licenses.json",
  "policy/native-dependencies.json",
  "scripts/check-licenses.ts",
  "scripts/check-storage-sql.ts",
  "src/workflow/constants.ts",
  "src/workflow/sqlite.ts",
  "src/workflow/storage-preconditions.ts",
  "src/workflow/config.ts",
  "src/workflow/index.ts",
  "src/shared/node-floor.ts",
  "docs/spec/design_v2/17_IMPLEMENTATION_ROADMAP.md",
  "docs/spec/design_v2/19_PLATFORM_AND_PACKAGE_BASELINE.md",
];

function existingFiles(): string[] {
  return CANDIDATE_NEW_FILES.filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
}

// ---------------------------------------------------------------------------
// SC-034 (NFR-003) — 검증 경로가 실 환경 경로를 쓰지 않는다
// ---------------------------------------------------------------------------

describe("SC-034: 검증 경로가 실 경로를 쓰지 않는다", () => {
  it("Happy: 신규 파일에 기본 설정 루트·LaunchAgents·전역 설치 경로에 대한 직접 쓰기가 0건이다", () => {
    const forbidden = [/~\/Library\/LaunchAgents/, /\.config\/adde(?!.{0,40}(임시|tmp|mkdtemp))/i];
    const hits: string[] = [];
    for (const rel of existingFiles()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      for (const re of forbidden) {
        if (re.test(text)) hits.push(`${rel}: ${re.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("Edge: 설정 루트가 필요한 지점(테스트)은 ADDE_HOME 주입 또는 installAddeHomeGuard 를 쓴다", () => {
    const wfTestDir = path.join(repoRoot, "test/workflow");
    if (!fs.existsSync(wfTestDir)) return;
    for (const f of fs.readdirSync(wfTestDir)) {
      if (!f.endsWith(".test.ts")) continue;
      const text = fs.readFileSync(path.join(wfTestDir, f), "utf8");
      if (/homedir\(\)/.test(text)) {
        expect(text).toMatch(/ADDE_HOME|installAddeHomeGuard/);
      }
    }
  });

  it("Error: os.homedir() 를 직접 조합해 쓰기 경로를 만드는 합성 코드는 위반으로 판정된다", () => {
    const broken =
      'const p = path.join(os.homedir(), ".config/adde", "x"); fs.writeFileSync(p, "y");';
    expect(/homedir\(\)/.test(broken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-038 (NFR-006) — 산출물에 키 자료 평문 없음
// ---------------------------------------------------------------------------

const KEY_MATERIAL_PATTERNS = [
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
];

describe("SC-038: 산출물에 키 자료가 평문으로 없다", () => {
  it("Happy: 신규 파일 전수 조회에서 토큰·키 자료 평문 0건이다", () => {
    const hits: string[] = [];
    for (const rel of existingFiles()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      for (const re of KEY_MATERIAL_PATTERNS) {
        if (re.test(text)) hits.push(`${rel}: ${re.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("Edge: capability 키 파일은 keyId·보유자 라벨로만 지칭된다(경로표 검사)", () => {
    const roadmap = path.join(repoRoot, "docs/spec/design_v2/17_IMPLEMENTATION_ROADMAP.md");
    if (!fs.existsSync(roadmap)) return;
    const text = fs.readFileSync(roadmap, "utf8");
    const idx = text.indexOf("capability 키 파일");
    if (idx === -1) return;
    const window = text.slice(idx, idx + 300);
    expect(window).toMatch(/keyId|식별자|보유자/);
  });

  it("Error: 합성 텍스트에 sk- 토큰 패턴이 있으면 검출된다", () => {
    const broken = "token=sk-abcdefghijklmnopqrstuvwx";
    expect(KEY_MATERIAL_PATTERNS.some((re) => re.test(broken))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-040 (NFR-008) — 과대 보호 주장 없음
// ---------------------------------------------------------------------------

const OVERCLAIM_PATTERNS = [
  /데이터\s*손상을?\s*(방지|막는다)/,
  /법적\s*(안전|보장)/,
  /전\s*대역에서\s*경고\s*없음/,
  /guarantees? (data )?(safety|no corruption)/i,
];

describe("SC-040: 과대 보호 주장이 없다", () => {
  it("Happy: 본 차수 추가·수정 텍스트에 금지 패턴 0건이다", () => {
    const hits: string[] = [];
    for (const rel of existingFiles()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      for (const re of OVERCLAIM_PATTERNS) {
        if (re.test(text)) hits.push(`${rel}: ${re.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("Edge: 경고 없음 서술이 있다면 25.0.0~25.6.x 대역 예외를 동반한다", () => {
    for (const rel of existingFiles()) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      if (/경고\s*없음/.test(text) && /하한\s*이상|전\s*대역/.test(text)) {
        expect(text).toMatch(/25\.0\.0|25\.6/);
      }
    }
  });

  it("Error: 금지 주장 패턴은 합성 텍스트에서 검출된다", () => {
    const broken = "본 체크는 데이터 손상을 방지한다.";
    expect(OVERCLAIM_PATTERNS.some((re) => re.test(broken))).toBe(true);
  });
});
