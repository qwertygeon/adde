import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseInbox,
  sentLine,
  sendingLine,
  formatStamp,
  stampFromIso,
  isoFromStamp,
  outNoteBase,
  renderApprovalBlock,
  parseApprovals,
  finalizeApprovalDeny,
  isConflictFile,
  createMarkdownSource,
} from "../../src/src-adapters/markdown.js";
import type { Source } from "../../src/src-adapters/source.js";
import type { PermRequest } from "../../src/gate/gate.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { LaneConf } from "../../src/shared/conf.js";

/** 테스트 공용 전송 스탬프 — 형식만 유효하면 값은 임의. */
const STAMP = "20260101-000000";

/** 실시간 폴링 대기 — fs.watch 이벤트 지연 흡수. */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("isConflictFile", () => {
  it("Syncthing/Obsidian 충돌 파일명을 판별한다", () => {
    expect(isConflictFile("inbox.sync-conflict-20260628-1.md")).toBe(true);
    expect(isConflictFile("inbox (conflicted copy 2026).md")).toBe(true);
    expect(isConflictFile("note.conflicted.md")).toBe(true);
    expect(isConflictFile("inbox.md")).toBe(false);
    expect(isConflictFile("approvals.md")).toBe(false);
  });
});

describe("parseInbox (actions)", () => {
  it("체크된 send 트리거 직전 세그먼트를 fresh 액션으로 추출한다", () => {
    const r = parseInbox("첫 메시지\n- [x] 📤 send\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "첫 메시지", lineIndex: 1 });
  });

  it("미체크 send 트리거는 액션을 만들지 않는다", () => {
    expect(parseInbox("작성 중\n- [ ] 📤 send\n").actions).toHaveLength(0);
  });

  it("빈 세그먼트의 체크 send 는 empty 액션", () => {
    const r = parseInbox("- [x] 📤 send\n");
    expect(r.actions).toEqual([{ kind: "empty", text: "", lineIndex: 0 }]);
  });

  it("종단(sent) 마커는 경계로 작동한다 — 다중 메시지", () => {
    const content = ["보낸 메시지", sentLine("old", STAMP), "두 번째", "- [x] 📤 send"].join("\n");
    const r = parseInbox(content);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "두 번째" });
  });

  it("종단 마커는 다시 트리거로 인식되지 않는다(멱등)", () => {
    expect(parseInbox("x\n" + sentLine("id-x", STAMP) + "\n").actions).toHaveLength(0);
  });

  it("구버전 sent 마커(`sent <id>`)도 경계로 작동한다(하위호환)", () => {
    expect(parseInbox("x\n- [x] ✅ sent legacy-id\n").actions).toHaveLength(0);
  });

  // A4: 전용 라벨 고정 — 'send' 정확 일치만 트리거
  it("A4: 본문에 send 가 포함된 체크박스는 트리거가 아니다", () => {
    const r = parseInbox("please send the file to me\n- [x] please send the file\n");
    expect(r.actions).toHaveLength(0);
  });

  it("A4: 라벨이 정확히 send 면(이모지 허용) 트리거", () => {
    expect(parseInbox("msg\n- [x] send\n").actions[0]).toMatchObject({ kind: "fresh" });
    expect(parseInbox("msg\n- [x] 🚀 send\n").actions[0]).toMatchObject({ kind: "fresh" });
  });

  it("A4: 트리거가 아닌 사용자 체크박스는 본문에 포함(경계 아님)", () => {
    const r = parseInbox("- [ ] buy milk\n해주세요\n- [x] send\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.text).toContain("buy milk");
    expect(r.actions[0]!.text).toContain("해주세요");
  });

  // A3: sending 마커는 resume 액션
  it("A3: sending 마커는 resume 액션으로 id·스탬프를 보존한다", () => {
    const content = ["재개 메시지", sendingLine("crash-id", STAMP)].join("\n");
    const r = parseInbox(content);
    expect(r.actions).toEqual([
      { kind: "resume", id: "crash-id", stamp: STAMP, text: "재개 메시지", lineIndex: 1 },
    ]);
  });

  it("A3: 구버전 sending 마커(스탬프 없음)는 stamp 없이 resume 액션", () => {
    const r = parseInbox("재개\n- [x] ⏳ sending old-id\n");
    expect(r.actions).toEqual([{ kind: "resume", id: "old-id", text: "재개", lineIndex: 1 }]);
  });
});

describe("전송 스탬프", () => {
  it("formatStamp 은 로컬 시각을 YYYYMMDD-HHmmss 로 표기한다", () => {
    expect(formatStamp(new Date(2026, 6, 3, 16, 20, 45))).toBe("20260703-162045");
  });

  it("isoFromStamp 는 스탬프를 ISO 로 복원한다(roundtrip)", () => {
    const iso = isoFromStamp("20260703-162045");
    expect(iso).not.toBeNull();
    expect(stampFromIso(iso!)).toBe("20260703-162045");
  });

  it("isoFromStamp 는 형식 불일치에 null", () => {
    expect(isoFromStamp("not-a-stamp")).toBeNull();
    expect(isoFromStamp("2026-07-03")).toBeNull();
  });

  it("sent 라인은 out 노트 basename 위키링크를 담는다", () => {
    expect(sentLine("id-1", "20260703-162045")).toBe("- [x] ✅ sent [[20260703-162045 id-1]]");
    expect(outNoteBase("20260703-162045", "id-1")).toBe("20260703-162045 id-1");
  });
});

describe("approvals 파싱", () => {
  const req: PermRequest = {
    v: 1,
    id: "req-1",
    lane: "L",
    channel: "markdown",
    tool: "Bash",
    detail: "rm -rf build/",
    cwd: "/proj",
    ts: "2026-06-28T00:00:00Z",
  };

  it("renderApprovalBlock 은 pending 마커와 allow/deny 박스를 포함한다", () => {
    const block = renderApprovalBlock(req);
    expect(block).toContain("status=pending");
    expect(block).toContain("id=req-1");
    expect(block).toContain("- [ ] allow");
    expect(block).toContain("- [ ] deny");
  });

  it("renderApprovalBlock 은 요청 시각·자동 거부 기한을 표기한다", () => {
    const now = new Date(2026, 6, 3, 16, 20, 45);
    const block = renderApprovalBlock(req, undefined, now);
    expect(block).toContain("20260703-162045"); // 요청 시각 스탬프
    expect(block).toContain("자동 거부"); // 기한 안내(테스트 로케일 ko)
  });

  it("allow 단일 체크 → allow 결정 + 마커 종단 재작성", () => {
    const content = renderApprovalBlock(req).replace("- [ ] allow", "- [x] allow");
    const r = parseApprovals(content);
    expect(r.decisions).toEqual([{ reqId: "req-1", decision: "allow" }]);
    expect(r.newContent).toContain("status=allow");
    expect(r.newContent).not.toContain("status=pending");
  });

  it("deny 단일 체크 → deny 결정", () => {
    const content = renderApprovalBlock(req).replace("- [ ] deny", "- [x] deny");
    const r = parseApprovals(content);
    expect(r.decisions).toEqual([{ reqId: "req-1", decision: "deny" }]);
  });

  it("양쪽 체크 = 모호 → 결정 없음(pending 유지)", () => {
    const content = renderApprovalBlock(req)
      .replace("- [ ] allow", "- [x] allow")
      .replace("- [ ] deny", "- [x] deny");
    const r = parseApprovals(content);
    expect(r.decisions).toHaveLength(0);
    expect(r.changed).toBe(false);
  });

  it("무체크 → 결정 없음", () => {
    const r = parseApprovals(renderApprovalBlock(req));
    expect(r.decisions).toHaveLength(0);
  });

  it("종단된 블록은 재처리하지 않는다(멱등)", () => {
    const resolved = renderApprovalBlock(req).replace("status=pending", "status=allow");
    const withCheck = resolved.replace("- [ ] allow", "- [x] allow");
    const r = parseApprovals(withCheck);
    expect(r.decisions).toHaveLength(0);
  });

  it("finalizeApprovalDeny 는 pending 을 deny(timeout) 로 종단한다", () => {
    const r = finalizeApprovalDeny(renderApprovalBlock(req), "req-1", "timeout");
    expect(r.changed).toBe(true);
    expect(r.newContent).toContain("status=deny");
    expect(r.newContent).toContain("reason=timeout");
  });
});

describe("createMarkdownSource (통합)", () => {
  let tmpBase: string;
  let rootDir: string;
  let paths: ReturnType<typeof lanePaths>;
  let conf: LaneConf;
  let source: Source | null = null;

  function makeSource(): Source {
    return createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
  }

  /** queueDir 부재 시 0 — readdirSync ENOENT 회피. */
  function msgCount(): number {
    if (!fs.existsSync(paths.queueDir)) return 0;
    return fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length;
  }

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-markdown-"));
    rootDir = path.join(tmpBase, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    paths = lanePaths(tmpBase, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    conf = {
      source: "markdown",
      backend: "acp",
      engine: "claude",
      channel: "markdown",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: [],
      root: rootDir,
      inbox: "inbox.md",
    };
  });

  afterEach(() => {
    if (source) source.stop();
    source = null;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("root/inbox conf 누락 시 생성에서 throw (fail-closed)", () => {
    const bad: LaneConf = { ...conf };
    delete bad.root;
    expect(() =>
      createMarkdownSource({ lane: "L", proj: "p", engine: "e", paths, conf: bad }),
    ).toThrow();
  });

  it("없는 root 경로로 start 시 throw", () => {
    conf.root = path.join(tmpBase, "NoSuchRoot");
    source = makeSource();
    expect(() => source!.start()).toThrow();
  });

  it("inbox 상대경로에 '..' 면 start 시 throw (root 탈출 방지, 011-C)", () => {
    conf.inbox = "../escape.md";
    source = makeSource();
    expect(() => source!.start()).toThrow();
  });

  it("outbox 절대경로면 start 시 throw (011-C)", () => {
    conf.outbox = path.join(tmpBase, "evil");
    source = makeSource();
    expect(() => source!.start()).toThrow();
  });

  // A1: 제어 노트가 AI 작업폴더(cwd) 내부면 fail-closed 기동 거부
  it("A1: inbox 가 cwd 내부면 start 거부(자기승인 방지)", () => {
    conf.cwd = rootDir; // 작업폴더 = 노트 루트 → inbox 가 cwd 내부
    source = makeSource();
    expect(() => source!.start()).toThrow(/자기승인|cwd/);
  });

  it("A1: 제어 노트가 cwd 밖이면 정상 기동", () => {
    conf.cwd = path.join(tmpBase, "project"); // 노트 루트와 분리
    fs.mkdirSync(conf.cwd, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    expect(() => source!.start()).not.toThrow();
  });

  it("상호 배타(006): approvals 와 outbox 가 같은 경로면 start 거부", () => {
    conf.approvals = "shared";
    conf.outbox = "shared";
    source = makeSource();
    expect(() => source!.start()).toThrow(/포함 관계|분리/);
  });

  it("상호 배타(006): inbox 노트가 outbox 디렉터리 내부면 start 거부", () => {
    conf.inbox = "out/inbox.md";
    conf.outbox = "out";
    source = makeSource();
    expect(() => source!.start()).toThrow(/겹칩니다|분리/);
  });

  it.runIf(process.platform === "darwin")(
    "상호 배타(006): 대소문자만 다른 경로(macOS 대소문자 무시 FS)도 start 거부",
    () => {
      conf.approvals = "Shared";
      conf.outbox = "shared";
      source = makeSource();
      expect(() => source!.start()).toThrow(/포함 관계|분리/);
    },
  );

  it("상호 배타(006): approvals 를 격리 디렉터리(.conflicts)와 겹치게 두면 start 거부", () => {
    conf.approvals = ".conflicts";
    source = makeSource();
    expect(() => source!.start()).toThrow(/포함 관계|분리/);
  });

  it("인박스의 체크된 send 블록을 envelope 으로 큐잉하고 sent 로 종단한다", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "마크다운 노트에서 보낸 지시\n- [x] 📤 send\n");

    source = makeSource();
    source.start(); // 기동 시 초기 1회 처리

    await waitFor(() => msgCount() >= 1);

    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["source"]).toBe("markdown");
    expect(env["text"]).toBe("마크다운 노트에서 보낸 지시");
    expect(env["lane"]).toBe("L");

    // 인박스가 sent 종단으로 재작성됨
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes("sent"));

    // 자기쓰기 가드: 종단 후 추가 enqueue 없음
    await new Promise((r) => setTimeout(r, 200));
    expect(msgCount()).toBe(1);
  });

  // FR-12: enqueue 연속 실패 임계 도달 시 outbox 알림 노트 1회
  it("enqueue 연속 실패가 임계에 도달하면 outbox 에 알림 노트를 1회 기록한다 (FR-12)", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    // 3개 send 블록 — 한 처리 패스에서 enqueue 가 3회 연속 실패하도록.
    fs.writeFileSync(
      inboxPath,
      "메시지1\n- [x] 📤 send\n메시지2\n- [x] 📤 send\n메시지3\n- [x] 📤 send\n",
    );
    // enqueue 실패 강제: queueDir 경로에 (디렉터리 대신) 파일을 둬 mkdir(recursive) 가 실패하게 한다.
    fs.mkdirSync(path.dirname(paths.queueDir), { recursive: true });
    fs.writeFileSync(paths.queueDir, "block");

    source = makeSource();
    source.start();

    const alertPath = path.join(rootDir, "out", "_enqueue-alert.md");
    await waitFor(() => fs.existsSync(alertPath));
    expect(fs.readFileSync(alertPath, "utf8")).toContain("enqueue");
  });

  // A3: 크래시(enqueue 전 sending 마킹만 남음) → 재기동 시 정확히 1회 enqueue
  it("A3: sending 마커가 큐에 없으면 재기동 시 재enqueue 후 sent 종단", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    // 크래시 시뮬레이션: sending <id> <stamp> 만 남고 enqueue 는 안 된 상태
    fs.writeFileSync(inboxPath, `복구될 메시지\n${sendingLine("crash-1", STAMP)}\n`);

    source = makeSource();
    source.start();

    await waitFor(() => msgCount() >= 1);
    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(files.some((f) => f.includes("crash-1"))).toBe(true);
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["id"]).toBe("crash-1");
    expect(env["text"]).toBe("복구될 메시지");
    // 재개 envelope.ts 는 sending 라인의 스탬프를 재현한다(sent 링크·노트 파일명 일치).
    expect(stampFromIso(env["ts"] as string)).toBe(STAMP);

    // sent 종단은 스탬프+id 위키링크
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(`sent [[${STAMP} crash-1]]`));
    // 중복 없음
    await new Promise((r) => setTimeout(r, 150));
    expect(msgCount()).toBe(1);
  });

  // A3: 이미 처리된 sending(out 존재) → 재enqueue 없이 종단만
  it("A3: sending 마커의 id 가 이미 out 에 있으면 재enqueue 하지 않는다", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, `이미 처리됨\n${sendingLine("done-1", STAMP)}\n`);
    // out/<id>.out 존재 = 이미 완료된 메시지
    fs.writeFileSync(path.join(paths.outDir, "done-1.out"), "응답");

    source = makeSource();
    source.start();

    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(`sent [[${STAMP} done-1]]`));
    expect(msgCount()).toBe(0); // 큐에 재enqueue 되지 않음
  });

  it("동기 충돌 파일은 격리되고 큐잉되지 않는다", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "정상\n");
    source = makeSource();
    source.start();

    // start 이후 충돌 파일 생성 → watch 가 격리
    const conflict = path.join(rootDir, "inbox.sync-conflict-20260628-abc.md");
    fs.writeFileSync(conflict, "악성 트리거\n- [x] 📤 send\n");

    await waitFor(() =>
      fs.existsSync(path.join(rootDir, ".conflicts", "inbox.sync-conflict-20260628-abc.md")),
    );
    expect(msgCount()).toBe(0);
  });

  it("권한 요청 → 요청당 approvals 파일 기록 → allow 체크 감지 → onDecision(allow) (011-D)", async () => {
    // 요청당 파일(D): approvals/<req-id>.md (기본 approvalsDir = inbox 형제 approvals/).
    const reqFile = path.join(rootDir, "approvals", "req-allow.md");
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    const decisions: string[] = [];
    source.onDecision((reqId, decision) => decisions.push(`${reqId}:${decision}`));

    const req: PermRequest = {
      v: 1,
      id: "req-allow",
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    };
    await source.requestPermission(req);

    await waitFor(
      () => fs.existsSync(reqFile) && fs.readFileSync(reqFile, "utf8").includes("req-allow"),
    );

    // 사용자가 allow 체크
    const cur = fs.readFileSync(reqFile, "utf8");
    fs.writeFileSync(reqFile, cur.replace("- [ ] allow", "- [x] allow"));

    await waitFor(() => decisions.includes("req-allow:allow"));
    expect(decisions).toContain("req-allow:allow");

    // 해당 요청 파일이 종단 재작성됨
    await waitFor(() => fs.readFileSync(reqFile, "utf8").includes("status=allow"));
  });

  it("경로 탈출 req.id(엔진 sessionId)는 fail-closed throw — approvals 밖 쓰기 차단", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    const evil: PermRequest = {
      v: 1,
      id: "../../evil",
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    };
    // 게이트가 sendPermPrompt(=requestPermission) throw 를 deny 로 처리하므로 throw 가 곧 fail-closed.
    await expect(source.requestPermission(evil)).rejects.toThrow();
    // approvals 디렉터리 밖(rootDir 상위)에 evil.md 가 생기지 않아야 한다.
    expect(fs.existsSync(path.join(rootDir, "..", "evil.md"))).toBe(false);
  });

  it("동시 다중 권한 요청은 요청당 별도 파일로 격리된다 (011-D)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    const mk = (id: string): PermRequest => ({
      v: 1,
      id,
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    });
    await source.requestPermission(mk("req-a"));
    await source.requestPermission(mk("req-b"));

    const fileA = path.join(rootDir, "approvals", "req-a.md");
    const fileB = path.join(rootDir, "approvals", "req-b.md");
    await waitFor(() => fs.existsSync(fileA) && fs.existsSync(fileB));
    expect(fs.readFileSync(fileA, "utf8")).toContain("req-a");
    expect(fs.readFileSync(fileB, "utf8")).toContain("req-b");

    // req-a 만 allow 체크 → req-a 만 결정, req-b 는 pending 유지(격리)
    const decisions: string[] = [];
    source.onDecision((reqId, decision) => decisions.push(`${reqId}:${decision}`));
    fs.writeFileSync(fileA, fs.readFileSync(fileA, "utf8").replace("- [ ] allow", "- [x] allow"));

    await waitFor(() => decisions.includes("req-a:allow"));
    expect(decisions).toContain("req-a:allow");
    expect(decisions.some((d) => d.startsWith("req-b"))).toBe(false);
    expect(fs.readFileSync(fileB, "utf8")).toContain("status=pending");
  });

  it("renderOut(id) 호출 시 마크다운 출력 노트를 작성한다(reply_ref 역참조 포함)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    // injector 가 writeOut 후 in-process 로 renderOut 호출(out/ watch 제거)
    fs.writeFileSync(
      path.join(paths.outDir, "msg-1.out.json"),
      JSON.stringify({ reply_ref: { channel_msg_id: "orig-9" } }),
    );
    fs.writeFileSync(path.join(paths.outDir, "msg-1.out"), "에이전트 응답입니다");

    await source.renderOut("msg-1");

    // origin_ts 없는 구버전 sidecar → 종전 `<id>.md` 파일명 유지(하위호환)
    const notePath = path.join(rootDir, "out", "msg-1.md");
    expect(fs.existsSync(notePath)).toBe(true);
    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("에이전트 응답입니다");
    expect(note).toContain("orig-9");
  });

  it("E2E 계약: sent 위키링크 텍스트 == renderOut 노트 파일명 (전 경로 관통)", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "질문입니다\n- [x] 📤 send\n");

    source = makeSource();
    source.start();

    // 인박스 처리 → sent 위키링크 확보
    await waitFor(() => /sent \[\[.+\]\]/.test(fs.readFileSync(inboxPath, "utf8")));
    const link = /sent \[\[(.+)\]\]/.exec(fs.readFileSync(inboxPath, "utf8"))![1]!;

    // 큐 envelope 로 injector 의 writeOut 을 재현(origin_ts = envelope.ts)
    const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as {
      id: string;
      ts: string;
    };
    fs.writeFileSync(
      path.join(paths.outDir, `${env.id}.out.json`),
      JSON.stringify({ reply_ref: { channel_msg_id: env.id }, origin_ts: env.ts }),
    );
    fs.writeFileSync(path.join(paths.outDir, `${env.id}.out`), "응답");

    await source.renderOut(env.id);

    // 링크 텍스트 그대로가 노트 파일명이어야 링크가 해소된다
    expect(fs.existsSync(path.join(rootDir, "out", `${link}.md`))).toBe(true);
  });

  it("renderOut: origin_ts sidecar → 스탬프 파일명 + 질문·시각 헤더", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    const originIso = isoFromStamp("20260703-162045")!;
    const doneIso = isoFromStamp("20260703-162130")!;
    fs.writeFileSync(
      path.join(paths.outDir, "msg-2.out.json"),
      JSON.stringify({
        reply_ref: { channel_msg_id: "msg-2" },
        origin_ts: originIso,
        ts: doneIso,
        question: "빌드 오류 원인 분석해줘",
      }),
    );
    fs.writeFileSync(path.join(paths.outDir, "msg-2.out"), "분석 결과입니다");

    await source.renderOut("msg-2");

    // 파일명 = sent 위키링크 텍스트(outNoteBase)와 동일 — 링크 해소 계약
    const notePath = path.join(rootDir, "out", `${outNoteBase("20260703-162045", "msg-2")}.md`);
    expect(fs.existsSync(notePath)).toBe(true);
    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("분석 결과입니다");
    expect(note).toContain("> ❓ 빌드 오류 원인 분석해줘");
    expect(note).toContain("20260703-162045"); // 요청 스탬프
    expect(note).toContain("20260703-162130"); // 완료 스탬프
  });
});
