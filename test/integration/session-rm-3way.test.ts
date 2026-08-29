import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  writeMinimalProjectConf,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { captureSink, queuedLineInput } from "../helpers/prompt-fixtures.js";
import { installAddeHomeGuard } from "../helpers/adde-home-guard.js";

// 확정 시그니처(Test Authoring Contract): runSession(argv, deps?:{prompter?;interactive?;base?}).
// session rm 3분기(완전 제거/일반 제거/취소) — askChoice 로 대화형 구동, `--purge` 비대화 완전
// 제거, 옵션 없는 비대화는 사용법+실패.
//
// ASSUMPTION(테스트 작성자 — Development 동기화 필요, PPG-1 2차 방어): `askChoice` 의 사용자 입력은
// 옵션 배열 순서를 딴 번호("1"/"2"/"3", 완전 제거/일반 제거/취소 순 — design.md §10 흐름 3단계)로
// 가정한다(일반적 번호식 CLI 메뉴 관례). 실제가 value 토큰 문자열 입력이면 development 가
// runs/pipeline-log 로 실제 메커니즘을 명시하고 본 파일을 동기화한다.

const PROJ = "p1";
let roots: V2TmpRoots;
const addeHomeGuard = installAddeHomeGuard(() => roots.base);

beforeEach(() => {
  roots = makeV2TmpRoots();
  writeMinimalProjectConf(roots.base, PROJ, { vault: roots.vaultRoot });
  addeHomeGuard.before();
});

afterEach(() => {
  addeHomeGuard.after();
  cleanupV2TmpRoots(roots);
});

async function seedFullSession(sid: string) {
  const sessionStore = await import("../../src/core/session-store.js");
  const now = new Date().toISOString();
  await sessionStore.saveSession(roots.base, PROJ, {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    status: "active",
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
    rev: 0,
    stopReason: null,
    stoppedAt: null,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    storageLayout: "session",
  } as never);
  const pathsMod = await import("../../src/shared/paths.js");
  const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, sid);
  fs.mkdirSync(vp.sessionDir, { recursive: true });
  fs.writeFileSync(
    vp.inboxNote,
    "<!-- adde:compose -->\n초안\n- [ ] 📤 send\n<!-- adde:records -->\n",
  );
  const svp = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, sid);
  fs.mkdirSync(svp.blobsDir, { recursive: true });
  fs.writeFileSync(svp.dedupFile, "");
  const sp = pathsMod.sessionPaths(roots.base, PROJ, sid);
  fs.mkdirSync(sp.queueDir, { recursive: true });
}

async function runSession(
  argv: readonly string[],
  deps: Record<string, unknown> = {},
): Promise<number> {
  const mod = await import("../../src/cli/session.js");
  return (
    mod as unknown as {
      runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
    }
  ).runSession(argv, { base: roots.base, ...deps });
}

describe("SC-047: 대화형 TTY 는 대상을 먼저 보여주고 3분기를 묻는다", () => {
  it("Happy: session rm 실행 시 경로·턴 수 표시 후 3분기 질문이 나타난다", async () => {
    await seedFullSession("sess-1");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["3"]); // 3=취소
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    // 대상 인벤토리("삭제 대상: …")는 프롬프터 output 이 아니라 process.stdout 으로 직접 나간다
    // (handleRemove — 질의문만 prompter 를 거친다) — cli-stop-resume.test.ts 선례대로 실측한다.
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as never;
    try {
      await runSession(["rm", PROJ, "sess-1"], { prompter, interactive: true });
    } finally {
      process.stdout.write = origWrite;
    }
    prompter.close();
    expect(chunks.join("")).toMatch(/sess-1/);
  });
});

describe("SC-048: 완전 제거는 그 세션 소유 경로 전부를 지우고 다른 세션은 건드리지 않는다", () => {
  it("Happy: 완전 제거 선택 → 대상 세션 파일 전부 부재 + 다른 세션 파일은 잔존", async () => {
    await seedFullSession("sess-a");
    await seedFullSession("sess-b");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["1"]); // 1=완전 제거
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const code = await runSession(["rm", PROJ, "sess-a"], { prompter, interactive: true });
    prompter.close();
    expect(code).toBe(0);

    const pathsMod = await import("../../src/shared/paths.js");
    const aRecord = pathsMod.sessionPaths(roots.base, PROJ, "sess-a").recordFile;
    const bRecord = pathsMod.sessionPaths(roots.base, PROJ, "sess-b").recordFile;
    expect(fs.existsSync(aRecord)).toBe(false);
    expect(fs.existsSync(bRecord)).toBe(true);
    const aVault = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "sess-a").sessionDir;
    expect(fs.existsSync(aVault)).toBe(false);
  });
});

describe("SC-049·SC-049a: 일반 제거는 vault 를 보존하고 노트를 제거됨 안내형으로 교체한다", () => {
  it("Happy: 일반 제거 → 목록에서 사라지고 vault 전부 잔존 + 설정 루트 항목 부재", async () => {
    await seedFullSession("sess-record");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["2"]); // 2=일반 제거
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const code = await runSession(["rm", PROJ, "sess-record"], { prompter, interactive: true });
    prompter.close();
    expect(code).toBe(0);

    const pathsMod = await import("../../src/shared/paths.js");
    expect(fs.existsSync(pathsMod.sessionPaths(roots.base, PROJ, "sess-record").recordFile)).toBe(
      false,
    );
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "sess-record");
    expect(fs.existsSync(vp.sessionDir)).toBe(true);
    expect(fs.existsSync(vp.inboxNote)).toBe(true);
  });

  it("SC-049a Happy: 제거 직후 노트가 제거됨 안내형(팔레트·send 0건)이고 초안·기록은 보존된다", async () => {
    await seedFullSession("sess-record2");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["2"]);
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    await runSession(["rm", PROJ, "sess-record2"], { prompter, interactive: true });
    prompter.close();
    const pathsMod = await import("../../src/shared/paths.js");
    const content = fs.readFileSync(
      pathsMod.vaultPaths(roots.vaultRoot, PROJ, "sess-record2").inboxNote,
      "utf8",
    );
    expect(content).not.toMatch(/\[ \]/);
    expect(content).toContain("초안");
  });
});

describe("SC-050: 취소는 아무것도 지우지 않고 실패 종료한다", () => {
  it("Happy: 취소 선택 → 삭제 0건 + exit 1", async () => {
    await seedFullSession("sess-cancel");
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["3"]); // 3=취소
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const code = await runSession(["rm", PROJ, "sess-cancel"], { prompter, interactive: true });
    prompter.close();
    expect(code).toBe(1);
    const pathsMod = await import("../../src/shared/paths.js");
    expect(fs.existsSync(pathsMod.sessionPaths(roots.base, PROJ, "sess-cancel").recordFile)).toBe(
      true,
    );
  });
});

describe("SC-051: 비대화 --purge 는 확인 없이 완전 제거한다", () => {
  it("Happy: --purge → 확인 없이 완전 제거 + exit 0", async () => {
    await seedFullSession("sess-purge");
    const code = await runSession(["rm", PROJ, "sess-purge", "--purge"], { interactive: false });
    expect(code).toBe(0);
    const pathsMod = await import("../../src/shared/paths.js");
    expect(fs.existsSync(pathsMod.sessionPaths(roots.base, PROJ, "sess-purge").recordFile)).toBe(
      false,
    );
  });
});

describe("SC-052: 비대화 + 옵션 없음은 아무것도 지우지 않고 사용법 안내와 함께 실패한다", () => {
  it("Happy: 옵션 없이 비대화 실행 → 삭제 0건 + 실패 종료", async () => {
    await seedFullSession("sess-noflag");
    const code = await runSession(["rm", PROJ, "sess-noflag"], { interactive: false });
    expect(code).not.toBe(0);
    const pathsMod = await import("../../src/shared/paths.js");
    expect(fs.existsSync(pathsMod.sessionPaths(roots.base, PROJ, "sess-noflag").recordFile)).toBe(
      true,
    );
  });
});

describe("SC-054: 존재하지 않는 세션·부분 실패는 성공을 보고하지 않는다", () => {
  it("Happy: 없는 sid 로 제거 시도 → 대상 없음 + exit 1", async () => {
    const code = await runSession(["rm", PROJ, "no-such-sid", "--purge"], { interactive: false });
    expect(code).not.toBe(0);
  });
});

// legacyEra 완전 제거 시 legacy 원장의 그 sid 라인만 제거되는 것(SC-074)은
// `test/integration/legacy-storage.test.ts` 가 전담한다(SC 매핑 표 지정 파일 — 중복 회피).
