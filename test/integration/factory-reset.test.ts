import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  writeMinimalProjectConf,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeFactoryResetDeps } from "../helpers/fake-factory-reset.js";
import { captureSink, queuedLineInput } from "../helpers/prompt-fixtures.js";
import { installAddeHomeGuard } from "../helpers/adde-home-guard.js";

// rm 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은 read-only
// 바인딩이라 실패).
const rmCtl = vi.hoisted(() => ({ failWith: null as (() => Error) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmCtl.failWith) {
        const err = rmCtl.failWith();
        rmCtl.failWith = null;
        throw err;
      }
      return actual.rm(...args);
    },
  };
});

// SC-076~082 (FR-030) — 공장 초기화는 **격리 통합 테스트로만** 판정한다(design.md 테스트 전략 —
// 실행하면 실제 설치가 파괴된다). 데몬 정지·잔존 확인은 FactoryResetDeps 주입 더블로 재현한다.
// 실 launchd·실 vault·실 ~/.config/adde 는 어떤 테스트도 건드리지 않는다(테스트 격리 원칙 — 이
// 파일은 특히 파괴적이라 ADDE_HOME 이중 격리가 필수다).

let roots: V2TmpRoots;
const addeHomeGuard = installAddeHomeGuard(() => roots.base);

beforeEach(() => {
  roots = makeV2TmpRoots();
  addeHomeGuard.before();
});

afterEach(() => {
  rmCtl.failWith = null;
  addeHomeGuard.after();
  cleanupV2TmpRoots(roots);
});

function seedProject(proj: string, sessionCount: number): void {
  writeMinimalProjectConf(roots.base, proj, { vault: roots.vaultRoot });
  const projDir = path.join(roots.base, "projects", proj, "sessions.d");
  fs.mkdirSync(projDir, { recursive: true });
  for (let i = 0; i < sessionCount; i++) {
    fs.writeFileSync(path.join(projDir, `sid-${i}.json`), "{}");
  }
  const vaultProjDir = path.join(roots.vaultRoot, "adde", "projects", proj);
  fs.mkdirSync(path.join(vaultProjDir, "sessions"), { recursive: true });
}

function seedV02xLegacy(proj: string): string {
  const legacyDir = path.join(roots.base, proj, "lanes.d");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "lane1.json"), "{}");
  return legacyDir;
}

function seedStray(): string {
  const strayDir = path.join(roots.vaultRoot, "adde", "projects", "stray-proj");
  fs.mkdirSync(strayDir, { recursive: true });
  return strayDir;
}

async function runFactoryReset(
  argv: readonly string[],
  deps: Record<string, unknown> = {},
): Promise<{ code: number; text: string }> {
  const mod = await import("../../src/cli/factory-reset.js");
  const { output } = captureSink();
  const { createPrompter } = await import("../../src/cli/prompt.js");
  const prompter =
    (deps["prompter"] as unknown) ?? createPrompter({ input: queuedLineInput([]).stream, output });
  // 인벤토리·결과는 process.stdout, 실패·거부 사유는 process.stderr 으로 직접 나간다
  // (cli/factory-reset.ts — 질의문만 prompter 를 거친다). 질의문(askPhrase 등)의 문구도 함께
  // 확인해야 하는 호출부는 여전히 자기 captureSink().output 을 prompter 에 꽂아 쓰되, 결과 텍스트
  // 단언은 이 반환값(`text`)을 쓴다 — cli-stop-resume.test.ts 선례를 stderr 까지 확장해 실측한다.
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => {
    chunks.push(String(c));
    return true;
  }) as never;
  process.stderr.write = ((c: string) => {
    chunks.push(String(c));
    return true;
  }) as never;
  let code: number;
  try {
    code = await (
      mod as unknown as {
        runFactoryReset: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
      }
    ).runFactoryReset(argv, { base: roots.base, interactive: false, ...deps, prompter });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, text: chunks.join("") };
}

describe("SC-076: 초기화는 설정·vault ADDE 서브트리를 지우고 vault 루트·밖 파일은 보존한다", () => {
  it("Happy: 프로젝트 2·세션 3 초기화 완료 → 설정 컨테이너·vault ADDE 서브트리 부재 + vault 루트 밖 파일 잔존", async () => {
    seedProject("proj-a", 2);
    seedProject("proj-b", 1);
    const outsideFile = path.join(roots.vaultRoot, "user-notes.md");
    fs.writeFileSync(outsideFile, "사용자 파일");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects"))).toBe(false);
    expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects", "proj-a"))).toBe(false);
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(fs.existsSync(roots.vaultRoot)).toBe(true);
  }, 15000);
});

describe("SC-077: v0.2.x 레이아웃은 초기화 대상이 아니다", () => {
  it("Happy: v0.2.x 공존 시 그 디렉터리가 무변경이고 결과에 '보존했음'이 명시된다", async () => {
    seedProject("proj-v2", 1);
    const legacyDir = seedV02xLegacy("proj-v2");
    const before = fs.readdirSync(legacyDir);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.readdirSync(legacyDir)).toEqual(before);
    expect(text).toMatch(/보존|preserve/i);
  }, 15000);
});

describe("SC-078: 데몬이 상주 중이면 먼저 정지하거나 거부한다", () => {
  it("Happy: 데몬 정지 후 삭제 → 초기화 후 레코드 파일이 되만들어지지 않는다", async () => {
    seedProject("proj-daemon", 1);
    const { deps, control } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(control.stopCallCount()).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-daemon"))).toBe(false);
  }, 15000);

  it("Error: 정지 후에도 잔존하면 삭제 0건 + 사유 + exit 1", async () => {
    seedProject("proj-residue", 1);
    const { deps, control } = makeFakeFactoryResetDeps(roots.base);
    control.forceResidueAfterStop("proj-residue");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).not.toBe(0);
    expect(text.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-residue"))).toBe(true);
  }, 15000);
});

describe("SC-079: 대화형 실행은 인벤토리 표시 후 고정 문구 타이핑을 요구한다", () => {
  it("Happy: 인벤토리(프로젝트·세션 수) 선표시 + 정확한 문구 입력 → 실행", async () => {
    seedProject("proj-inv", 2);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    prompter.close();
    expect(text).toMatch(/proj-inv/);
    expect(code).toBe(0);
  }, 15000);

  it("Edge: 대소문자·공백 차이 입력은 불일치로 처리된다", async () => {
    seedProject("proj-case", 1);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["factory reset"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-case"))).toBe(true);
  }, 15000);

  it("Error: 틀린 입력·빈 입력 → 삭제 0건 + exit 1", async () => {
    seedProject("proj-wrong", 1);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput([""]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-wrong"))).toBe(true);
  }, 15000);
});

describe("SC-080: 비대화 실행은 사용법 안내와 함께 실패 종료한다", () => {
  it("Happy: 비대화 실행 → 삭제 0건 + 사용법 + 실패 종료", async () => {
    seedProject("proj-noninteractive", 1);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { code } = await runFactoryReset([], { interactive: false, reset: deps });
    expect(code).not.toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-noninteractive"))).toBe(true);
  }, 10000);
});

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Happy: 삭제 일부 실패 → 실패분 열거 + exit 1(성공 위장 금지)", async () => {
    seedProject("proj-partial", 1);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    rmCtl.failWith = () => new Error("simulated partial failure");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).not.toBe(0);
    expect(text).toMatch(/실패|fail/i);
  }, 15000);
});

describe("SC-082: 설정 밖 vault 잔존물(stray)은 자동 삭제하지 않고 별도 확인한다", () => {
  it("Happy: stray 프로젝트 디렉터리는 자동 삭제 0 + 열거 후 별도 확인", async () => {
    // stray 탐색은 등록된 프로젝트의 vaultRoot 를 앵커로만 수행된다(설정이 vault 경로를 알려주는
    // 유일한 근거 — factory-reset.ts buildResetInventory) — 등록 프로젝트 0개면 vaultRootsSeen 이
    // 비어 stray 스캔 루프 자체가 돌지 않는다. 앵커용 프로젝트 1개를 함께 시딩한다.
    seedProject("proj-anchor", 0);
    const strayDir = seedStray();
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    // 1차: FACTORY RESET 확인, 2차(있다면): stray 삭제 여부(기본 아니오) — 명시적으로 아니오.
    const __q = queuedLineInput(["FACTORY RESET", "n"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(strayDir)).toBe(true); // stray 는 확인 없이는 보존된다.
    // design.md §11 결과 보고는 stray 를 v0.2.x 와 달리 "경로 명시" 없이 건수로만 열거·보존
    // 확인한다(코드 확인 — formatInventory/보존 보고 둘 다 건수만 출력) — 디렉터리명 리터럴이
    // 아니라 그 건수 기반 문구로 판정한다(설계가 요구하지 않는 표기를 단언하지 않는다).
    expect(text).toMatch(/잔존물.*1건|보존한 stray: 1건/);
  }, 15000);

  it("Edge: 확인에 동의하면 stray 도 삭제된다", async () => {
    seedProject("proj-anchor", 0); // 위 Happy 케이스와 동일한 이유(stray 스캔 앵커).
    const strayDir = seedStray();
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "y"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(strayDir)).toBe(false);
  }, 15000);
});

// 보안 2차 수정 회귀(신규 SC 채번 없음 — 관련 기존 SC 의 Edge/Error 로 매핑, 매핑 근거는
// test-cases.md 갱신 필요분으로 별도 보고한다).

describe("SC-077: v0.2.x 레이아웃은 초기화 대상이 아니다", () => {
  it("Error(이름 충돌 거부): v0.2.x 프로젝트 이름이 'projects' 였던 경우 삭제 0건 + 거부", async () => {
    // 정상 v2 프로젝트가 함께 있어도 충돌 감지가 인벤토리 산출 자체를 막아 아무것도 지워지지 않아야
    // 한다(5단계 컨테이너 통삭제가 이 v0.2.x lanes.d 까지 삼킬 위험 — buildResetInventory 선두 가드).
    seedProject("proj-safe", 1);
    const collidingLanesDir = path.join(roots.base, "projects", "lanes.d");
    fs.mkdirSync(collidingLanesDir, { recursive: true });
    fs.writeFileSync(path.join(collidingLanesDir, "lane1.json"), "{}");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).not.toBe(0);
    expect(text).toMatch(/충돌|collision/i);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-safe"))).toBe(true);
    expect(fs.existsSync(collidingLanesDir)).toBe(true);
  }, 15000);
});

describe("SC-076: 초기화는 설정·vault ADDE 서브트리를 지우고 vault 루트·밖 파일은 보존한다", () => {
  it("Edge(불안전 이름 프로젝트): 인벤토리 산출이 죽지 않고 그 프로젝트는 생존하며 정상 프로젝트만 삭제된다", async () => {
    // proj 이름도 sid 필터와 대칭으로 안전 문자셋만 통과한다(isSafeSegment) — 걸러내지 않으면
    // projectPaths() 의 assertSafeSegment 가 throw 해 인벤토리 산출 루프 전체가 죽는다.
    seedProject("proj-ok", 1);
    const unsafeDir = path.join(roots.base, "projects", "bad name");
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(unsafeDir, "marker.txt"), "x");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-ok"))).toBe(false);
    expect(fs.existsSync(unsafeDir)).toBe(true);
    expect(text).toMatch(/bad name/);
  }, 15000);

  it("Edge(conf 파싱 실패 프로젝트): '해석 불가' 로 표시된 프로젝트가 실제로도 보존된다(표시=실제 일치)", async () => {
    seedProject("proj-ok2", 1);
    const brokenProjDir = path.join(roots.base, "projects", "proj-broken");
    fs.mkdirSync(brokenProjDir, { recursive: true });
    fs.writeFileSync(path.join(brokenProjDir, "project.conf"), "v=1\n"); // vault 누락 → 파싱 실패
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-ok2"))).toBe(false);
    expect(fs.existsSync(brokenProjDir)).toBe(true);
    expect(text).toMatch(/proj-broken/);
  }, 15000);

  it("Edge(빈 상위 디렉터리 정리): 삭제 후 vault 의 adde/projects·adde 자체도 정리되고 vault 루트는 남는다", async () => {
    // rmdirIfEmpty 자가발견 결함(recursive:false 는 빈 디렉터리에도 EISDIR) 회귀 — 종전엔 이 결과를
    // 직접 단언하는 테스트가 없어 잠복해 있었다.
    seedProject("proj-only", 1);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects"))).toBe(false);
    expect(fs.existsSync(path.join(roots.vaultRoot, "adde"))).toBe(false);
    expect(fs.existsSync(roots.vaultRoot)).toBe(true);
  }, 15000);
});

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Error(vault 서브트리 탈출): adde 가 vault 밖을 가리키는 심볼릭 링크면 삭제를 거부한다", async () => {
    seedProject("proj-escape", 1);
    const addeDir = path.join(roots.vaultRoot, "adde");
    const outsideTarget = fs.mkdtempSync(path.join(tmpdir(), "adde-escape-target-"));
    const escapeProjDir = path.join(outsideTarget, "projects", "proj-escape");
    fs.mkdirSync(escapeProjDir, { recursive: true });
    fs.writeFileSync(path.join(escapeProjDir, "sentinel.txt"), "outside data");
    // vault 내부의 실제 adde 디렉터리를 vault 밖 경로를 가리키는 심볼릭 링크로 치환한다 — 문자열상
    // 경로(`<vault>/adde/...`)는 vault 하위처럼 보이지만 실제 파괴 대상은 vault 밖이다.
    fs.rmSync(addeDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, addeDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code, text } = await runFactoryReset([], {
        interactive: true,
        prompter,
        reset: deps,
      });
      expect(code).not.toBe(0);
      expect(text).toMatch(/vault 서브트리 경로가 실제로는 vault 의 ADDE 폴더 밖을 가리킵니다/);
      expect(fs.existsSync(path.join(escapeProjDir, "sentinel.txt"))).toBe(true);
    } finally {
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  }, 15000);
});

// 보안 3차 수정 회귀 — 삭제 직전 가드가 **삭제 대상 자신**을 realpath 하고(중간 경로 구성요소의
// 링크까지 해석), 거부된 프로젝트의 설정 루트를 남기며, 6단계 stray 삭제에도 같은 가드가 적용되는지
// 확인한다. 입력은 GAP-030 (b) 가 실측으로 기록한 회귀 클래스(중간 구성요소 `adde/projects` 링크 ·
// `<proj>` 자신 링크 · `<vault>/adde` 링크 경유 stray)에서 그대로 뽑았다. 신규 SC 채번 없음 —
// 기존 SC 의 Edge/Error 로 매핑한다(test-cases.md 갱신은 AUTHORING 소관).

/** 심볼릭 링크 자체의 존재(대상이 사라져도 true) — existsSync 는 링크를 따라가 대상 부재면 false. */
function linkExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Error(중간 구성요소 링크): adde/projects 가 vault 밖 링크면 삭제를 거부하고 그 프로젝트의 설정 루트도 남긴다", async () => {
    // GAP-030 (b) 실측 회귀 클래스 — 종전 가드는 `<vault>` 와 `<vault>/adde` 만 realpath 해서
    // `adde/projects` 가 링크면 "inside" 로 통과했고 rm 이 링크를 따라가 vault 밖을 재귀 삭제했다.
    seedProject("proj-mid", 1);
    const projectsDir = path.join(roots.vaultRoot, "adde", "projects");
    const outsideTarget = fs.mkdtempSync(path.join(tmpdir(), "adde-mid-target-"));
    const outsideProjDir = path.join(outsideTarget, "proj-mid");
    fs.mkdirSync(outsideProjDir, { recursive: true });
    fs.writeFileSync(path.join(outsideProjDir, "sentinel.txt"), "outside data");
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, projectsDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code, text } = await runFactoryReset([], {
        interactive: true,
        prompter,
        reset: deps,
      });
      expect(code).not.toBe(0);
      expect(fs.existsSync(path.join(outsideProjDir, "sentinel.txt"))).toBe(true);
      // 설정 루트 생존 — 설정이 vault 경로를 알려주는 유일한 근거라 함께 보류해야 재시도가 가능하다.
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-mid"))).toBe(true);
      expect(text).toMatch(/설정 삭제를 모두 보류했습니다/);
      expect(text).not.toMatch(/초기화 완료/); // 제거 보고(removedProjects)에 올라가지 않는다.
    } finally {
      fs.rmSync(projectsDir, { force: true });
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  }, 15000);

  it("Error(대상 자신 링크): <vault>/adde/projects/<proj> 가 링크면 링크도 지우지 않고 거부한다", async () => {
    // rm 은 링크 경로에 대해 링크만 지우므로(실측) 데이터 탈출이 실증되는 케이스는 아니다 —
    // 가드가 대상 자신을 해석하는지에 대한 fail-closed 심층 방어 회귀다(development run-028 유보 동형).
    seedProject("proj-self", 1);
    const targetDir = path.join(roots.vaultRoot, "adde", "projects", "proj-self");
    const outsideTarget = fs.mkdtempSync(path.join(tmpdir(), "adde-self-target-"));
    fs.writeFileSync(path.join(outsideTarget, "sentinel.txt"), "outside data");
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, targetDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code, text } = await runFactoryReset([], {
        interactive: true,
        prompter,
        reset: deps,
      });
      expect(code).not.toBe(0);
      expect(linkExists(targetDir)).toBe(true);
      expect(fs.existsSync(path.join(outsideTarget, "sentinel.txt"))).toBe(true);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-self"))).toBe(true);
      expect(text).toMatch(/설정 삭제를 모두 보류했습니다/);
    } finally {
      fs.rmSync(targetDir, { force: true });
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  }, 15000);

  it("Error(혼합): 같은 vault 의 정상 프로젝트만 삭제되고 거부된 프로젝트는 vault·설정 모두 남는다", async () => {
    seedProject("proj-good", 1);
    seedProject("proj-bad", 1);
    const badVaultDir = path.join(roots.vaultRoot, "adde", "projects", "proj-bad");
    const outsideTarget = fs.mkdtempSync(path.join(tmpdir(), "adde-mixed-target-"));
    fs.writeFileSync(path.join(outsideTarget, "sentinel.txt"), "outside data");
    fs.rmSync(badVaultDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, badVaultDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
      expect(code).not.toBe(0);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-good"))).toBe(false);
      expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects", "proj-good"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-bad"))).toBe(true);
      expect(linkExists(badVaultDir)).toBe(true);
      expect(fs.existsSync(path.join(outsideTarget, "sentinel.txt"))).toBe(true);
      // 거부 프로젝트의 링크가 남아 있으므로 상위 디렉터리도 비지 않는다.
      expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects"))).toBe(true);
      expect(fs.existsSync(path.join(roots.vaultRoot, "adde"))).toBe(true);
    } finally {
      fs.rmSync(badVaultDir, { force: true });
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  }, 15000);
});

describe("SC-082: 설정 밖 vault 잔존물(stray)은 자동 삭제하지 않고 별도 확인한다", () => {
  it("Error(stray 링크 경유): <vault>/adde 가 vault 밖 링크면 동의해도 stray 삭제를 거부한다", async () => {
    // GAP-030 (b) 는 6단계 stray 삭제에 가드 호출이 아예 없어 `deleteStrays:true` 에서 vault 밖
    // 파일이 실제로 삭제됨을 실측했다 — 그 입력을 그대로 재현한다(경로 구성요소가 링크라 rm 이
    // 링크가 아닌 실제 외부 디렉터리를 재귀 삭제한다).
    seedProject("proj-anchor", 0);
    const addeDir = path.join(roots.vaultRoot, "adde");
    const outsideTarget = fs.mkdtempSync(path.join(tmpdir(), "adde-stray-target-"));
    const outsideStrayDir = path.join(outsideTarget, "projects", "stray-proj");
    fs.mkdirSync(outsideStrayDir, { recursive: true });
    fs.writeFileSync(path.join(outsideStrayDir, "sentinel.txt"), "outside data");
    fs.rmSync(addeDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, addeDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "y"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code, text } = await runFactoryReset([], {
        interactive: true,
        prompter,
        reset: deps,
      });
      expect(code).not.toBe(0);
      expect(fs.existsSync(path.join(outsideStrayDir, "sentinel.txt"))).toBe(true);
      expect(fs.existsSync(outsideStrayDir)).toBe(true);
      // stray 전용 사유(보류 대상이 vault 삭제뿐)와 4단계 사유는 문구가 구분된다.
      expect(text).toMatch(/vault 잔존물 경로가 실제로는 vault 의 ADDE 폴더 밖을 가리킵니다/);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-anchor"))).toBe(true);
    } finally {
      fs.rmSync(addeDir, { force: true });
      fs.rmSync(outsideTarget, { recursive: true, force: true });
    }
  }, 15000);
});

describe("SC-076: 초기화는 설정·vault ADDE 서브트리를 지우고 vault 루트·밖 파일은 보존한다", () => {
  it("Edge(vault 루트가 링크): vault 자체가 심볼릭 링크여도 정상 삭제되고 링크·루트 사용자 파일은 남는다", async () => {
    // 가드가 vaultRoot 도 realpath 하므로 링크 vault 는 과차단되지 않아야 한다(대상 자신 해석으로
    // 바꾼 수정이 정상 경로를 깨뜨리지 않았는지의 회귀 가드).
    const linkParent = fs.mkdtempSync(path.join(tmpdir(), "adde-linkvault-"));
    const realVault = path.join(linkParent, "real-vault");
    const linkVault = path.join(linkParent, "link-vault");
    fs.mkdirSync(realVault, { recursive: true });
    fs.symlinkSync(realVault, linkVault, "dir");
    const userFile = path.join(realVault, "user-notes.md");
    fs.writeFileSync(userFile, "사용자 파일");
    writeMinimalProjectConf(roots.base, "proj-linkvault", { vault: linkVault });
    fs.mkdirSync(path.join(roots.base, "projects", "proj-linkvault", "sessions.d"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(linkVault, "adde", "projects", "proj-linkvault", "sessions"), {
      recursive: true,
    });
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(realVault, "adde", "projects", "proj-linkvault"))).toBe(false);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-linkvault"))).toBe(false);
      expect(linkExists(linkVault)).toBe(true);
      expect(fs.existsSync(userFile)).toBe(true);
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  }, 15000);

  it("Edge(vault 서브트리 부재): 지울 대상이 없는 프로젝트는 실패 0건으로 설정 루트만 삭제된다", async () => {
    // 대상 부재는 realpath 가 ENOENT 라 "검사 없는 통과" 가 되기 쉬운 자리다 — 최근접 존재 조상
    // 해석으로 같은 내부 판정을 통과해야 무해한 absent 로 취급된다(과차단·과통과 양쪽 회귀 가드).
    writeMinimalProjectConf(roots.base, "proj-absent", { vault: roots.vaultRoot });
    fs.mkdirSync(path.join(roots.base, "projects", "proj-absent", "sessions.d"), {
      recursive: true,
    });
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(text).toMatch(/초기화 완료/);
    expect(text).not.toMatch(/일부 실패/);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-absent"))).toBe(false);
    expect(fs.existsSync(roots.vaultRoot)).toBe(true);
  }, 15000);
});

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Error(해석 자체 불가): 자기참조 링크(ELOOP)는 부재로 흡수되지 않고 거부된다", async () => {
    // 가드는 ENOENT 만 "부재" 로 흡수하고 그 밖의 해석 실패는 fail-closed 로 거부한다 — 이 분기가
    // 없으면 해석 불가 경로가 조사 없이 통과해 실제 파괴 반경을 알 수 없는 상태로 rm 이 돈다.
    seedProject("proj-loop", 1);
    const loopDir = path.join(roots.vaultRoot, "adde", "projects", "proj-loop");
    fs.rmSync(loopDir, { recursive: true, force: true });
    fs.symlinkSync(loopDir, loopDir, "dir");
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["FACTORY RESET"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    try {
      const { code, text } = await runFactoryReset([], {
        interactive: true,
        prompter,
        reset: deps,
      });
      expect(code).not.toBe(0);
      expect(text).toMatch(/설정 삭제를 모두 보류했습니다/);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-loop"))).toBe(true);
      expect(linkExists(loopDir)).toBe(true);
    } finally {
      fs.rmSync(loopDir, { force: true });
    }
  }, 15000);
});

// 보안 4차 수정 회귀(DEC-011) — conf 는 읽혔으나 `vault` 경로 자체를 해석할 수 없는 프로젝트는
// 인벤토리에 경로·사유와 함께 표시되고, 고정 문구 확인 뒤 **별도 명시 동의(기본 아니오)** 로만 설정
// 루트가 지워진다(vault 쪽은 어느 분기에서도 열지 않는다). 인벤토리 시점엔 해석됐던 vault 가 실행
// 시점에 깨지는 것은 동의 범위 밖이라 fail-closed 로 거부한다. 입력은 GAP-031 이 임시 프로브로
// 실측한 회귀 클래스(vault 부재 → failures 0 · exit 0 으로 설정만 삭제)에서 그대로 뽑았다.
// 신규 SC 채번 없음 — 기존 SC 의 Edge/Error 로 매핑한다(test-cases.md 갱신은 AUTHORING 소관).

/** 반드시 존재하지 않는 tmp 경로 — mkdtemp 로 유일성을 얻은 뒤 지워 부재를 보장한다(다른 테스트·잔존
 * 디렉터리와 이름이 겹쳐 "우연히 존재" 하는 상태를 만들지 않는다). */
function reserveMissingPath(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** conf 는 정상이나 vault 를 해석할 수 없는 프로젝트 — 설정 루트만 만들고 vault 는 만들지 않는다. */
function seedProjectUnresolvableVault(proj: string, vaultPath: string): string {
  writeMinimalProjectConf(roots.base, proj, { vault: vaultPath });
  const sessionsDir = path.join(roots.base, "projects", proj, "sessions.d");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "sid-0.json"), "{}");
  return path.join(roots.base, "projects", proj);
}

describe("SC-079: 대화형 실행은 인벤토리 표시 후 고정 문구 타이핑을 요구한다", () => {
  it("Edge(vault 해석 불가 표시 + 아니오): 경로·사유가 인벤토리에 표시되고 별도 질의에 아니오면 설정이 보존된다", async () => {
    const missingVault = reserveMissingPath("adde-missing-vault-");
    const projRoot = seedProjectUnresolvableVault("proj-novault", missingVault);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const sink = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "n"]);
    const prompter = createPrompter({ input: __q.stream, output: sink.output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    // 표시 단정을 종료코드보다 앞에 둔다 — 분류 자체가 사라지는 회귀에서 "무엇이 출력됐는지" 가
    // 먼저 드러나야 원인 추적이 짧다.
    expect(text).toMatch(/vault 를 해석할 수 없는 프로젝트\(별도 확인 대상\): 1건/);
    expect(text).toMatch(/- proj-novault \(vault=.*, 사유: 경로 없음\)/);
    expect(code).toBe(0);
    // 별도 질의가 실제로 노출됐는지는 프롬프터 출력에서 본다(질의문만 prompter 를 거친다).
    expect(sink.text()).toMatch(/설정만 지우시겠습니까\?/);
    expect(fs.existsSync(projRoot)).toBe(true); // 아니오 = 위치 단서 보존.
    expect(text).toMatch(/보존한 프로젝트\(vault 해석 불가, 설정 유지\): proj-novault/);
    expect(text).not.toMatch(/일부 실패/); // 사용자 선택이므로 failures 가 아니다.
    expect(fs.existsSync(missingVault)).toBe(false); // vault 쪽은 어느 분기에서도 열지 않는다.
  }, 15000);

  it("Edge(빈 입력 = 기본 아니오): 라벨이 (y/N) 이고 그대로 Enter 하면 설정이 보존된다", async () => {
    // CV-6 — 라벨의 기본값 방향과 실제 판정이 일치해야 한다(라벨만 (y/N) 이고 빈 입력이 삭제로
    // 흐르면 파괴적 조작이 무입력으로 일어난다).
    const missingVault = reserveMissingPath("adde-missing-vault-default-");
    const projRoot = seedProjectUnresolvableVault("proj-default-n", missingVault);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const sink = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", ""]);
    const prompter = createPrompter({ input: __q.stream, output: sink.output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(sink.text()).toMatch(/설정만 지우시겠습니까\?[^\n]*\(y\/N\)/);
    expect(fs.existsSync(projRoot)).toBe(true);
    expect(text).toMatch(/보존한 프로젝트\(vault 해석 불가, 설정 유지\): proj-default-n/);
  }, 15000);

  it.skipIf(process.getuid?.() === 0)(
    "Edge(권한 거부 사유): vault 상위가 접근 불가면 사유가 '권한 거부' 로 표시된다",
    async () => {
      // root 로 실행하면 mode 000 디렉터리도 통과해 EACCES 가 발생하지 않으므로(POSIX — 권한
      // 검사 면제) 그 환경에서는 이 사유를 재현할 수 없어 건너뛴다.
      const lockedParent = fs.mkdtempSync(path.join(tmpdir(), "adde-locked-vault-"));
      const lockedVault = path.join(lockedParent, "vault");
      fs.mkdirSync(lockedVault, { recursive: true });
      fs.chmodSync(lockedParent, 0o000);
      const projRoot = seedProjectUnresolvableVault("proj-noaccess", lockedVault);
      const { deps } = makeFakeFactoryResetDeps(roots.base);
      const { createPrompter } = await import("../../src/cli/prompt.js");
      const sink = captureSink();
      const __q = queuedLineInput(["FACTORY RESET", "n"]);
      const prompter = createPrompter({ input: __q.stream, output: sink.output });
      __q.arm(prompter);
      try {
        const { code, text } = await runFactoryReset([], {
          interactive: true,
          prompter,
          reset: deps,
        });
        expect(code).toBe(0);
        expect(text).toMatch(/- proj-noaccess \(vault=.*, 사유: 권한 거부\)/);
        expect(fs.existsSync(projRoot)).toBe(true);
      } finally {
        fs.chmodSync(lockedParent, 0o755);
        fs.rmSync(lockedParent, { recursive: true, force: true });
      }
    },
    15000,
  );

  it("Edge(삭제 대상 0 + 해석 불가만): 조기 종료하지 않고 확인 절차까지 진행한다", async () => {
    // 조기 종료 조건에서 vaultUnresolvable 을 빼면 이 프로젝트의 존재조차 사용자에게 보고되지
    // 않는다(조용한 무동작) — 그 분기를 닫는 회귀 가드다.
    const missingVault = reserveMissingPath("adde-missing-vault-only-");
    seedProjectUnresolvableVault("proj-only-novault", missingVault);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const sink = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "n"]);
    const prompter = createPrompter({ input: __q.stream, output: sink.output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(text).not.toMatch(/삭제할 대상이 없습니다/);
    expect(text).toMatch(/프로젝트: 0개/);
    expect(text).toMatch(/공장 초기화/); // 경고 문구까지 도달.
    expect(sink.text()).toMatch(/문구 그대로 입력/); // 고정 문구 확인 도달.
    expect(sink.text()).toMatch(/설정만 지우시겠습니까\?/); // 별도 동의 질의 도달.
  }, 15000);
});

describe("SC-076: 초기화는 설정·vault ADDE 서브트리를 지우고 vault 루트·밖 파일은 보존한다", () => {
  it("Edge(vault 해석 불가 + 동의): 설정 루트만 삭제되고 vault 경로는 열지 않는다", async () => {
    const missingVault = reserveMissingPath("adde-missing-vault-yes-");
    const projRoot = seedProjectUnresolvableVault("proj-cfgonly", missingVault);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const sink = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "y"]);
    const prompter = createPrompter({ input: __q.stream, output: sink.output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(projRoot)).toBe(false);
    expect(text).toMatch(/초기화 완료 — 프로젝트 1개 제거/);
    expect(text).not.toMatch(/보존한 프로젝트\(vault 해석 불가/);
    // 해석 불가 경로를 삭제 경로로 쓰면 부재 디렉터리가 생성되거나 상위가 정리된다 — 어느 쪽도 없다.
    expect(fs.existsSync(missingVault)).toBe(false);
    expect(fs.existsSync(path.dirname(missingVault))).toBe(true);
  }, 15000);

  it("Edge(혼합): 정상 프로젝트는 vault·설정 모두 삭제되고 해석 불가 프로젝트는 설정이 남는다", async () => {
    seedProject("proj-normal", 1);
    const missingVault = reserveMissingPath("adde-missing-vault-mixed-");
    const novaultRoot = seedProjectUnresolvableVault("proj-mixed-novault", missingVault);
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const sink = captureSink();
    const __q = queuedLineInput(["FACTORY RESET", "n"]);
    const prompter = createPrompter({ input: __q.stream, output: sink.output });
    __q.arm(prompter);
    const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-normal"))).toBe(false);
    expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects", "proj-normal"))).toBe(
      false,
    );
    expect(fs.existsSync(novaultRoot)).toBe(true);
    expect(text).toMatch(/초기화 완료 — 프로젝트 1개 제거/);
    expect(text).toMatch(/보존한 프로젝트\(vault 해석 불가, 설정 유지\): proj-mixed-novault/);
    expect(text).not.toMatch(/일부 실패/);
  }, 15000);
});

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Error(실행 시점 해석 실패): 인벤토리 후 vault 가 사라지면 vault·설정 삭제를 모두 보류한다", async () => {
    // 사용자가 동의한 것은 "인벤토리에 표시된 상태" 에 대한 삭제다 — 확인과 실행 사이에 vault 가
    // 해석 불가가 되면 삭제 반경을 확정할 수 없으므로 fail-closed 로 거부해야 한다. 이 경합은 CLI
    // 관통으로는 주입 지점이 없어(확인과 실행 사이에 훅이 없다) 코어를 직접 호출해 재현한다 —
    // 이 파일 최초의 코어 직접 호출이다.
    const caseVault = fs.mkdtempSync(path.join(tmpdir(), "adde-runtime-gone-vault-"));
    const movedVault = `${caseVault}-moved`;
    writeMinimalProjectConf(roots.base, "proj-runtime-gone", { vault: caseVault });
    const projRoot = path.join(roots.base, "projects", "proj-runtime-gone");
    fs.mkdirSync(path.join(projRoot, "sessions.d"), { recursive: true });
    fs.mkdirSync(path.join(caseVault, "adde", "projects", "proj-runtime-gone", "sessions"), {
      recursive: true,
    });
    const { deps } = makeFakeFactoryResetDeps(roots.base);
    const core = await import("../../src/core/factory-reset.js");
    try {
      const inv = await core.buildResetInventory(deps);
      // 인벤토리 시점엔 정상 해석된다(해석 불가 분류 대상이 아니다).
      expect(inv.vaultUnresolvable).toHaveLength(0);
      expect(inv.projects.map((p) => p.proj)).toContain("proj-runtime-gone");
      fs.renameSync(caseVault, movedVault); // 확인과 실행 사이에 vault 가 사라진다.
      const report = await core.executeFactoryReset(
        inv,
        { deleteStrays: false, deleteConfigOfUnresolvableVault: false },
        deps,
      );
      expect(report.failures.map((f) => f.reason).join("\n")).toMatch(
        /vault 경로를 해석할 수 없습니다/,
      );
      expect(report.removedProjects).not.toContain("proj-runtime-gone");
      expect(report.removedVaultSubtrees).toHaveLength(0);
      expect(fs.existsSync(projRoot)).toBe(true); // 설정 루트 생존 — 재실행으로 재시도 가능.
      // 옮겨간 vault 데이터는 그대로 남는다(삭제 반경 미확정 상태에서 아무것도 지우지 않는다).
      expect(
        fs.existsSync(path.join(movedVault, "adde", "projects", "proj-runtime-gone", "sessions")),
      ).toBe(true);
    } finally {
      fs.rmSync(caseVault, { recursive: true, force: true });
      fs.rmSync(movedVault, { recursive: true, force: true });
    }
  }, 15000);
});

// 보안 5차 수정 회귀(DEC-012) — ① 삭제 직전 가드의 비교 기준이 vault 루트가 아니라 **ADDE
// 네임스페이스**(`realpath(<vault>)` + lexical `adde`)라, vault **안에서** ADDE 밖을 가리키는
// 재지향도 거부되는지 ② 파괴 동의 화면·결과·실패 열거의 표시값이 제어문자를 접어 줄을 위조할 수
// 없는지 확인한다. 입력은 GAP-032 가 실측으로 기록한 회귀 클래스(`<vault>/adde/projects` →
// `<vault>/MyNotes` · `<vault>/adde` → `<vault>` · stray → vault 안 ADDE 밖 · conf `vault` 값과
// 디렉터리 이름의 CR/ANSI/실개행)에서 그대로 뽑았다. 신규 SC 채번 없음 — 기존 SC 의 Edge/Error 로
// 매핑한다(test-cases.md 갱신은 AUTHORING 소관).

/** 출력에 남은 제어문자(개행 제외 — 줄 구분자는 정상 출력이다) — 위조 벡터가 표시 표면까지
 * 도달했는지의 직접 계측. */
function controlCharsExceptNewline(text: string): string[] {
  return [...text].filter((ch) => /\p{Cc}/u.test(ch) && ch !== "\n");
}

/** 이 파일의 표준 대화형 실행 배선(고정 문구 + 이어지는 y/n 응답) — 신규 케이스가 늘면서
 * 보일러플레이트가 케이스 본문의 의도를 가린다. */
async function runInteractive(
  answers: readonly string[],
): Promise<{ code: number; text: string; promptText: () => string }> {
  const { deps } = makeFakeFactoryResetDeps(roots.base);
  const { createPrompter } = await import("../../src/cli/prompt.js");
  const sink = captureSink();
  const __q = queuedLineInput([...answers]);
  const prompter = createPrompter({ input: __q.stream, output: sink.output });
  __q.arm(prompter);
  const { code, text } = await runFactoryReset([], { interactive: true, prompter, reset: deps });
  return { code, text, promptText: sink.text };
}

describe("SC-076: 초기화는 설정·vault ADDE 서브트리를 지우고 vault 루트·밖 파일은 보존한다", () => {
  it("Error(vault 안 ADDE 밖 재지향): adde/projects 가 <vault>/MyNotes 링크면 거부하고 사용자 문서를 보존한다", async () => {
    // GAP-032 SEC-021 실측 회귀 클래스 — vault 루트 기준 가드에서는 이 경로가 "vault 안" 이라
    // 통과해 사용자 문서가 재귀 삭제되고 성공까지 보고됐다(SC-076 문언 위반).
    seedProject("proj-innotes", 1);
    const projectsDir = path.join(roots.vaultRoot, "adde", "projects");
    const myNotes = path.join(roots.vaultRoot, "MyNotes");
    fs.mkdirSync(path.join(myNotes, "proj-innotes"), { recursive: true });
    fs.writeFileSync(path.join(myNotes, "proj-innotes", "sentinel.md"), "사용자 문서");
    // 링크 대상 **밖**의 vault 사용자 폴더 — 링크 대상 안에 두면 stray 로 열거돼(이름이 프로젝트와
    // 다르므로) 추가 질의가 뜨고, 이 케이스가 검증하려는 4단계 거부와 무관한 분기가 섞인다.
    const myDocs = path.join(roots.vaultRoot, "MyDocs");
    fs.mkdirSync(myDocs, { recursive: true });
    fs.writeFileSync(path.join(myDocs, "top.md"), "사용자 문서");
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.symlinkSync(myNotes, projectsDir, "dir");
    try {
      const { code, text } = await runInteractive(["FACTORY RESET"]);
      expect(code).not.toBe(0);
      expect(fs.readFileSync(path.join(myNotes, "proj-innotes", "sentinel.md"), "utf8")).toBe(
        "사용자 문서",
      );
      expect(fs.existsSync(path.join(myDocs, "top.md"))).toBe(true);
      // 설정 루트도 함께 보류 — vault 경로를 알려주는 유일한 근거다.
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-innotes"))).toBe(true);
      expect(text).toMatch(/vault 의 ADDE 폴더 밖을 가리킵니다/);
      expect(text).not.toMatch(/초기화 완료/);
    } finally {
      fs.rmSync(projectsDir, { force: true }); // 링크 자신만 제거(대상은 vault 정리에 맡긴다).
    }
  }, 15000);

  it("Error(자기상위 재지향): <vault>/adde 가 <vault> 를 가리키면 거부하고 vault 루트의 형제 디렉터리를 보존한다", async () => {
    seedProject("proj-selfup", 1);
    const addeDir = path.join(roots.vaultRoot, "adde");
    const siblingProj = path.join(roots.vaultRoot, "projects", "proj-selfup");
    fs.mkdirSync(siblingProj, { recursive: true });
    fs.writeFileSync(path.join(siblingProj, "sentinel.md"), "사용자 문서");
    fs.writeFileSync(path.join(roots.vaultRoot, "user-notes.md"), "사용자 문서");
    fs.rmSync(addeDir, { recursive: true, force: true });
    fs.symlinkSync(roots.vaultRoot, addeDir, "dir");
    try {
      const { code, text } = await runInteractive(["FACTORY RESET"]);
      expect(code).not.toBe(0);
      expect(fs.readFileSync(path.join(siblingProj, "sentinel.md"), "utf8")).toBe("사용자 문서");
      expect(fs.existsSync(path.join(roots.vaultRoot, "user-notes.md"))).toBe(true);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-selfup"))).toBe(true);
      expect(linkExists(addeDir)).toBe(true);
      expect(text).toMatch(/vault 의 ADDE 폴더 밖을 가리킵니다/);
    } finally {
      fs.rmSync(addeDir, { force: true });
    }
  }, 15000);

  it("Error(네임스페이스 루트 자신): <proj> 링크가 <vault>/adde 로 해석되면 동일 경로도 거부한다", async () => {
    // 엄격 내부 판정(동일 경로 거부)의 판별 입력 — 포함 판정만 하면 이 대상이 "inside" 로 통과해
    // 4·6단계의 삭제 단위(그 **하위** 프로젝트 디렉터리)를 벗어난 대상에 rm 이 돈다.
    seedProject("proj-eqroot", 1);
    const targetDir = path.join(roots.vaultRoot, "adde", "projects", "proj-eqroot");
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(roots.vaultRoot, "adde"), targetDir, "dir");
    try {
      const { code, text } = await runInteractive(["FACTORY RESET"]);
      expect(code).not.toBe(0);
      expect(linkExists(targetDir)).toBe(true);
      expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects"))).toBe(true);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-eqroot"))).toBe(true);
      expect(text).toMatch(/vault 의 ADDE 폴더 밖을 가리킵니다/);
    } finally {
      fs.rmSync(targetDir, { force: true });
    }
  }, 15000);
});

describe("SC-082: 설정 밖 vault 잔존물(stray)은 자동 삭제하지 않고 별도 확인한다", () => {
  it("Error(stray 가 vault 안 ADDE 밖 링크): 동의해도 거부하고 정상 프로젝트만 삭제된다", async () => {
    seedProject("proj-ok-stray", 1);
    const other = path.join(roots.vaultRoot, "Other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "sentinel.md"), "사용자 문서");
    const strayLink = path.join(roots.vaultRoot, "adde", "projects", "stray-in-vault");
    fs.symlinkSync(other, strayLink, "dir");
    try {
      const { code, text } = await runInteractive(["FACTORY RESET", "y"]);
      expect(code).not.toBe(0);
      expect(fs.readFileSync(path.join(other, "sentinel.md"), "utf8")).toBe("사용자 문서");
      expect(linkExists(strayLink)).toBe(true);
      expect(text).toMatch(/vault 잔존물 경로가 실제로는 vault 의 ADDE 폴더 밖을 가리킵니다/);
      // 정상 프로젝트는 그대로 삭제된다(stray 거부가 다른 대상을 과차단하지 않는다).
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-ok-stray"))).toBe(false);
      expect(fs.existsSync(path.join(roots.vaultRoot, "adde", "projects", "proj-ok-stray"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(strayLink, { force: true });
    }
  }, 15000);
});

describe("SC-079: 대화형 실행은 인벤토리 표시 후 고정 문구 타이핑을 요구한다", () => {
  it("Edge(vault 값 위조): conf 의 vault 이름에 CR·ANSI CSI 가 있어도 한 줄로 접히고 삭제는 원문 경로로 일어난다", async () => {
    // 표시값만 접고 삭제 경로는 원문을 쓰는 계약의 양방향 회귀 — 접은 문자열로 지우면 화면과 다른
    // 경로를 지우고, 접지 않으면 ANSI CSI(줄 지우기)로 삭제 반경을 오판시킬 수 있다.
    const forgeParent = fs.mkdtempSync(path.join(tmpdir(), "adde-forge-vault-"));
    const forgedName = "vault\r\u001b[2K삭제할 대상이 없습니다";
    const forgedVault = path.join(forgeParent, forgedName);
    fs.mkdirSync(path.join(forgedVault, "adde", "projects", "proj-forge", "sessions"), {
      recursive: true,
    });
    writeMinimalProjectConf(roots.base, "proj-forge", { vault: forgedVault });
    fs.mkdirSync(path.join(roots.base, "projects", "proj-forge", "sessions.d"), {
      recursive: true,
    });
    try {
      const { code, text } = await runInteractive(["FACTORY RESET"]);
      expect(code).toBe(0);
      expect(controlCharsExceptNewline(text)).toEqual([]);
      const lines = text.split("\n");
      const projLines = lines.filter((l) => l.startsWith("  - proj-forge "));
      expect(projLines).toHaveLength(1);
      expect(projLines[0]).toMatch(/삭제할 대상이 없습니다\)$/); // 접혀서 같은 줄에 남는다.
      expect(lines.filter((l) => l.trim() === "삭제할 대상이 없습니다")).toHaveLength(0);
      // 삭제는 원문 경로 기준 — 접은 경로는 삭제·생성 대상이 되지 않는다.
      expect(fs.existsSync(path.join(forgedVault, "adde"))).toBe(false);
      expect(fs.readdirSync(forgeParent)).toEqual([forgedName]);
      expect(fs.existsSync(path.join(roots.base, "projects", "proj-forge"))).toBe(false);
    } finally {
      fs.rmSync(forgeParent, { recursive: true, force: true });
    }
  }, 15000);

  it("Edge(디렉터리 이름 위조): 불안전 이름에 실개행이 있어도 해석 불가 열거가 한 줄로 접힌다", async () => {
    // conf 파서는 값의 실개행을 통과시키지 않지만(`/\r?\n/` 분리), `<base>/projects` 하위 디렉터리
    // 이름은 readdir 산출이라 실개행이 그대로 표시 표면까지 온다 — 줄 위조가 실제로 가능한 자리다.
    seedProject("proj-normal2", 1);
    const forgedDirName = "bad\n삭제할 대상이 없습니다\n프로젝트: 0개";
    fs.mkdirSync(path.join(roots.base, "projects", forgedDirName), { recursive: true });
    const { code, text } = await runInteractive(["FACTORY RESET"]);
    expect(code).toBe(0);
    const lines = text.split("\n");
    // 위조 문자열이 독립 줄로 서지 않는다 — 헤더 형식 줄은 진짜 인벤토리 1줄뿐이다.
    expect(lines.filter((l) => /^프로젝트: \d+개$/.test(l))).toEqual(["프로젝트: 1개"]);
    expect(lines.filter((l) => l.trim() === "삭제할 대상이 없습니다")).toHaveLength(0);
    const unresolvedLines = lines.filter((l) => l.startsWith("해석 불가"));
    expect(unresolvedLines).toHaveLength(1);
    expect(unresolvedLines[0]).toContain("삭제할 대상이 없습니다");
    expect(unresolvedLines[0]).toContain("프로젝트: 0개");
    // 열거만 하고 삭제 대상에서 제외한다(고지와 실제 삭제 범위 일치).
    expect(fs.existsSync(path.join(roots.base, "projects", forgedDirName))).toBe(true);
    expect(fs.existsSync(path.join(roots.base, "projects", "proj-normal2"))).toBe(false);
  }, 15000);
});

describe("SC-081: 삭제 대상 일부 실패는 남은 경로를 열거하고 실패 종료한다", () => {
  it("Edge(실패 열거 위조): stray 이름의 실개행이 실패 줄을 위조하지 못한다", async () => {
    // 실패 열거는 인벤토리와 다른 출력 경로(stderr `일부 실패:`)라 살균 누락이 따로 생길 수 있다 —
    // 여기서 접히지 않으면 "초기화 완료" 위조 줄로 실패를 성공처럼 보이게 할 수 있다.
    seedProject("proj-anchor-fail", 0);
    const other = path.join(roots.vaultRoot, "OtherDocs");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "sentinel.md"), "사용자 문서");
    const forgedStrayName = "stray\n일부 실패: 없음\n초기화 완료 — 프로젝트 0개 제거.";
    const strayLink = path.join(roots.vaultRoot, "adde", "projects", forgedStrayName);
    fs.symlinkSync(other, strayLink, "dir");
    try {
      const { code, text } = await runInteractive(["FACTORY RESET", "y"]);
      expect(code).not.toBe(0);
      expect(controlCharsExceptNewline(text)).toEqual([]);
      const lines = text.split("\n");
      const failLines = lines.filter((l) => l.includes("일부 실패"));
      expect(failLines).toHaveLength(1);
      expect(failLines[0]).toContain("초기화 완료 — 프로젝트 0개 제거.");
      expect(lines.filter((l) => l.trim() === "초기화 완료 — 프로젝트 0개 제거.")).toHaveLength(0);
      expect(fs.readFileSync(path.join(other, "sentinel.md"), "utf8")).toBe("사용자 문서");
      expect(linkExists(strayLink)).toBe(true);
    } finally {
      fs.rmSync(strayLink, { force: true });
    }
  }, 15000);
});
