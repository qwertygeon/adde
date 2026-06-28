import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseInbox,
  inboxTerminalLine,
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

let idSeq = 0;
const genId = (): string => `id-${++idSeq}`;

/** 실시간 폴링 대기 — fs.watch 이벤트 지연 흡수. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
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

describe("parseInbox", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  it("체크된 send 박스 직전 세그먼트를 메시지로 추출한다", () => {
    const content = "첫 메시지\n- [x] 📤 send\n";
    const r = parseInbox(content, genId);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("첫 메시지");
    expect(r.messages[0]!.lineIndex).toBe(1);
  });

  it("미체크 send 박스는 메시지를 만들지 않는다", () => {
    const r = parseInbox("작성 중\n- [ ] 📤 send\n", genId);
    expect(r.messages).toHaveLength(0);
  });

  it("빈 세그먼트의 체크 send 는 empty 로 종단 마킹한다(메시지 없음)", () => {
    const r = parseInbox("- [x] 📤 send\n", genId);
    expect(r.messages).toHaveLength(0);
    expect(r.changed).toBe(true);
    expect(r.lines[0]).toContain("empty");
  });

  it("종단(sent) 마커는 세그먼트 경계로 작동한다 — 다중 메시지", () => {
    const content = ["보낸 메시지", inboxTerminalLine("old"), "두 번째", "- [x] 📤 send"].join("\n");
    const r = parseInbox(content, genId);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe("두 번째");
  });

  it("종단 마커는 다시 트리거로 인식되지 않는다(멱등)", () => {
    const content = "x\n" + inboxTerminalLine("id-x") + "\n";
    const r = parseInbox(content, genId);
    expect(r.messages).toHaveLength(0);
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
    expect(() => createMarkdownSource({ lane: "L", proj: "p", engine: "e", paths, conf: bad })).toThrow();
  });

  it("없는 root 경로로 start 시 throw", () => {
    conf.root = path.join(tmpBase, "NoSuchRoot");
    source = makeSource();
    expect(() => source!.start()).toThrow();
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

  it("동기 충돌 파일은 격리되고 큐잉되지 않는다", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "정상\n");
    source = makeSource();
    source.start();

    // start 이후 충돌 파일 생성 → watch 가 격리
    const conflict = path.join(rootDir, "inbox.sync-conflict-20260628-abc.md");
    fs.writeFileSync(conflict, "악성 트리거\n- [x] 📤 send\n");

    await waitFor(() => fs.existsSync(path.join(rootDir, ".conflicts", "inbox.sync-conflict-20260628-abc.md")));
    expect(msgCount()).toBe(0);
  });

  it("권한 요청 → approvals 블록 기록 → allow 체크 감지 → onDecision(allow)", async () => {
    const approvalsPath = path.join(rootDir, "approvals.md");
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

    await waitFor(() => fs.existsSync(approvalsPath) && fs.readFileSync(approvalsPath, "utf8").includes("req-allow"));

    // 사용자가 allow 체크
    const cur = fs.readFileSync(approvalsPath, "utf8");
    fs.writeFileSync(approvalsPath, cur.replace("- [ ] allow", "- [x] allow"));

    await waitFor(() => decisions.includes("req-allow:allow"));
    expect(decisions).toContain("req-allow:allow");

    // approvals 가 종단 재작성됨
    await waitFor(() => fs.readFileSync(approvalsPath, "utf8").includes("status=allow"));
  });

  it("out/<id>.out 생성 시 마크다운 출력 노트를 작성한다(reply_ref 역참조 포함)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    source.start();

    // start 이후 out 파일 생성 → watch
    fs.writeFileSync(path.join(paths.outDir, "msg-1.out.json"), JSON.stringify({ reply_ref: { channel_msg_id: "orig-9" } }));
    fs.writeFileSync(path.join(paths.outDir, "msg-1.out"), "에이전트 응답입니다");

    const notePath = path.join(rootDir, "out", "msg-1.md");
    await waitFor(() => fs.existsSync(notePath));
    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("에이전트 응답입니다");
    expect(note).toContain("orig-9");
  });
});
