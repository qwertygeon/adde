/**
 * Markdown 소스 어댑터 — 파일 핸드셰이크(버튼 없는 채널).
 * 임의 마크다운 에디터/동기 도구(대표 예: Obsidian)에서 노트 파일 편집만으로 구동.
 * 설계: docs/_internal/design/09-markdown-source-adapter.md.
 * 인박스 노트 편집 + send 체크박스 → envelope → 큐.
 * 권한: approvals 노트에 ⏳ 블록 append → allow/deny 체크 감지 → 게이트 반영. 무응답 → 타임아웃 deny.
 * 출력: out/<id>.out 감시 → 마크다운 출력 노트(one-file-per-message, atomic).
 * 동기 내성: *.sync-conflict* 격리·상태 마커 멱등 자기쓰기 가드·tmp→rename.
 */
import { watch, existsSync, mkdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import type { LaneConf } from "../shared/conf.js";
import { enqueue, hasId } from "../core/queue.js";
import type { Envelope } from "../shared/envelope.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import type { Source, DecisionCallback, Decision } from "./source.js";

const DEBOUNCE_MS = 150;

export interface MarkdownConfig {
  lane: string;
  proj: string;
  engine: string;
  paths: LanePaths;
  conf: LaneConf;
}

// --- 순수 파싱 (테스트 대상) -------------------------------------------------

/** 동기 충돌 파일 판별 — 파싱·실행 금지 대상(Obsidian Sync/Syncthing 등). */
export function isConflictFile(filename: string): boolean {
  return /\.sync-conflict|conflicted copy|\.conflicted\./i.test(filename);
}

/** 체크박스 라인 파싱: `- [ ]`/`- [x]` + 라벨. */
const CHECKBOX = /^\s*-\s*\[([ xX])\]\s+(.*)$/;

/** 라벨 앞쪽의 이모지·기호·공백을 제거하고 소문자화한 코어 토큰. */
function labelCore(label: string): string {
  return label.replace(/^[^\p{L}]+/u, "").toLowerCase();
}

/** send 트리거 라벨 판별 — 코어가 정확히 'send'(A4: 부분일치 금지). */
function isSendLabel(label: string): boolean {
  return labelCore(label) === "send";
}

/** 인박스 액션 — main 이 id 부여·enqueue·종단 마킹을 수행. */
export interface InboxAction {
  /** fresh=신규 트리거(새 id 필요) · resume=`sending <id>` 재개 · empty=빈 트리거. */
  kind: "fresh" | "resume" | "empty";
  lineIndex: number;
  text: string;
  /** resume 시 기존 id. */
  id?: string;
}

export interface InboxParse {
  actions: InboxAction[];
  lines: string[];
  trailingNewline: boolean;
}

/** send 트리거 라인을 단계별 마커로 재작성하는 헬퍼(A3 2단계 내구 마킹). */
export function sendingLine(id: string): string {
  return `- [x] ⏳ sending ${id}`;
}
export function sentLine(id: string): string {
  return `- [x] ✅ sent ${id}`;
}
export function emptyLine(): string {
  return "- [x] ⚠️ empty (no message)";
}

/**
 * 인박스 본문을 파싱해 액션 목록을 만든다(파일은 쓰지 않음, id 부여도 main 책임).
 * - 경계 라인: send 트리거(라벨=send)·`sending <id>`·종단(`sent`/`empty`) 체크박스.
 * - 그 외 체크박스(사용자 todo 등)는 메시지 본문으로 취급(경계 아님).
 * - 체크된 send 트리거 직전 세그먼트가 메시지(빈 세그먼트는 empty 액션).
 * - `sending <id>` 는 크래시 재개 후보(resume) — main 이 hasId 로 존재검사 후 보정.
 */
export function parseInbox(content: string): InboxParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const actions: InboxAction[] = [];
  let segmentStart = 0;

  const segment = (end: number): string => lines.slice(segmentStart, end).join("\n").trim();

  for (let i = 0; i < lines.length; i++) {
    const cb = CHECKBOX.exec(lines[i]!);
    if (!cb) continue; // 일반 텍스트 — 세그먼트 본문

    const checked = cb[1]!.toLowerCase() === "x";
    const label = cb[2]!.trim();
    const core = labelCore(label);

    if (core.startsWith("sending")) {
      const m = /sending\s+(\S+)/i.exec(label);
      if (m) actions.push({ kind: "resume", id: m[1]!, text: segment(i), lineIndex: i });
      segmentStart = i + 1;
      continue;
    }
    if (core.startsWith("sent") || core.startsWith("empty")) {
      segmentStart = i + 1; // 종단 마커 — 경계
      continue;
    }
    if (isSendLabel(label)) {
      if (checked) {
        const text = segment(i);
        actions.push(text.length > 0 ? { kind: "fresh", text, lineIndex: i } : { kind: "empty", text: "", lineIndex: i });
      }
      segmentStart = i + 1; // 체크/미체크 무관 경계
      continue;
    }
    // send/sent/sending/empty 가 아닌 체크박스 → 본문(경계 아님, segmentStart 유지)
  }

  return { actions, lines, trailingNewline };
}

const PERM_MARKER = /<!--\s*adde:perm\s+id=(\S+)\s+status=(\S+)\s*-->/;
const ALLOW_CHECKED = /^\s*-\s*\[x\]\s+.*\ballow\b/i;
const DENY_CHECKED = /^\s*-\s*\[x\]\s+.*\bdeny\b/i;

/** 권한 요청 1건을 approvals 노트 블록 문자열로 렌더(append 용, 말미 개행 포함). */
export function renderApprovalBlock(req: PermRequest): string {
  const detail = req.detail.replace(/\s+/g, " ").trim();
  return [
    `### ⏳ req ${req.id} · ${req.tool}`,
    `> ${detail}  (cwd: ${req.cwd})`,
    `- [ ] allow`,
    `- [ ] deny`,
    `<!-- adde:perm id=${req.id} status=pending -->`,
    "",
    "",
  ].join("\n");
}

export interface ApprovalDecision {
  reqId: string;
  decision: Decision;
}

export interface ApprovalsParse {
  decisions: ApprovalDecision[];
  newContent: string;
  changed: boolean;
}

/**
 * approvals 노트에서 결정된 권한 블록을 추출하고 종단 재작성한다.
 * - status=pending 블록에서 allow/deny 중 정확히 하나 체크 → 결정.
 * - 0개/2개 체크 = 모호 → pending 유지.
 * - 결정 블록은 marker status 와 헤딩을 종단 상태로 재작성(멱등 가드).
 */
export function parseApprovals(content: string): ApprovalsParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const decisions: ApprovalDecision[] = [];
  let changed = false;

  // marker 라인 인덱스 기준으로 블록 경계 분할.
  let blockStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = PERM_MARKER.exec(lines[i]!);
    if (!m) continue;

    const id = m[1]!;
    const status = m[2]!;
    const blockLines = lines.slice(blockStart, i);

    if (status === "pending") {
      const allow = blockLines.some((l) => ALLOW_CHECKED.test(l));
      const deny = blockLines.some((l) => DENY_CHECKED.test(l));
      if (allow !== deny) {
        const decision: Decision = allow ? "allow" : "deny";
        decisions.push({ reqId: id, decision });
        lines[i] = `<!-- adde:perm id=${id} status=${decision} -->`;
        // 헤딩 종단 표기(블록 내 첫 ### 라인).
        for (let j = blockStart; j < i; j++) {
          if (/^###\s/.test(lines[j]!)) {
            lines[j] = lines[j]!
              .replace(/^###\s+⏳/, `### ${decision === "allow" ? "✅" : "⛔"}`)
              .replace(/\breq\b/, `req(${decision})`);
            break;
          }
        }
        changed = true;
      }
    }
    blockStart = i + 1;
  }

  let newContent = lines.join("\n");
  if (trailingNewline && !newContent.endsWith("\n")) newContent += "\n";
  return { decisions, newContent, changed };
}

/** 타임아웃·강제 종단 시 pending 블록을 deny 로 재작성. 변경 없으면 changed=false. */
export function finalizeApprovalDeny(content: string, reqId: string, reason: string): ApprovalsParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = PERM_MARKER.exec(lines[i]!);
    if (m && m[1] === reqId && m[2] === "pending") {
      lines[i] = `<!-- adde:perm id=${reqId} status=deny reason=${reason} -->`;
      changed = true;
    }
  }
  let newContent = lines.join("\n");
  if (trailingNewline && !newContent.endsWith("\n")) newContent += "\n";
  return { decisions: [], newContent, changed };
}

// --- 어댑터 ------------------------------------------------------------------

/** root 상대 경로를 절대경로로 해소한다. 필수 키 누락 시 throw(fail-closed). */
function resolvePaths(conf: LaneConf): {
  rootDir: string;
  inboxPath: string;
  approvalsPath: string;
  outboxDir: string;
  quarantineDir: string;
} {
  if (!conf.root) throw new Error("[markdown] conf.root 누락 — 마크다운 루트 절대경로 필수");
  if (!conf.inbox) throw new Error("[markdown] conf.inbox 누락 — 입력 노트(root 상대) 필수");
  const rootDir = conf.root;
  const inboxPath = join(rootDir, conf.inbox);
  const inboxDir = dirname(inboxPath);
  const approvalsPath = conf.approvals
    ? join(rootDir, conf.approvals)
    : join(inboxDir, "approvals.md");
  const outboxDir = conf.outbox ? join(rootDir, conf.outbox) : join(inboxDir, "out");
  const quarantineDir = join(inboxDir, ".conflicts");
  return { rootDir, inboxPath, approvalsPath, outboxDir, quarantineDir };
}

export function createMarkdownSource(cfg: MarkdownConfig): Source {
  const { rootDir, inboxPath, approvalsPath, outboxDir, quarantineDir } = resolvePaths(cfg.conf);

  const decisionHandlers: DecisionCallback[] = [];
  const watchers: FSWatcher[] = [];
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const seenOut = new Set<string>();
  const lastSelfWrite = new Map<string, string>();
  let inboxBusy = false;
  let running = false;
  // approvals 파일 변경을 직렬화(append·결정 재작성·타임아웃 경합 방지).
  let approvalsLock: Promise<void> = Promise.resolve();

  /** 같은 디렉터리 tmp→rename 으로 원자 기록. */
  async function atomicWrite(filePath: string, content: string): Promise<void> {
    const dir = dirname(filePath);
    const tmp = join(dir, `.${basename(filePath)}.tmp`);
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
    lastSelfWrite.set(filePath, content);
  }

  function withApprovalsLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = approvalsLock.then(fn, fn);
    approvalsLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function normalize(id: string, text: string): Envelope {
    return {
      v: 1,
      id,
      lane: cfg.lane,
      source: "markdown",
      backend: "acp",
      engine: cfg.engine,
      project: cfg.proj,
      ts: new Date().toISOString(),
      text,
      reply_ref: { channel_msg_id: id },
    };
  }

  async function readMaybe(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  function joinLines(lines: string[], trailingNewline: boolean): string {
    return lines.join("\n") + (trailingNewline ? "\n" : "");
  }

  async function handleInbox(): Promise<void> {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const content = await readMaybe(inboxPath);
      if (content === null) return;
      if (lastSelfWrite.get(inboxPath) === content) return; // 자기쓰기 echo

      const { actions, lines, trailingNewline } = parseInbox(content);
      if (actions.length === 0) return;

      // Phase A: fresh→id 부여+sending 마킹, empty→마킹 (내구 기록 후 enqueue).
      const pending: Array<{ id: string; text: string; lineIndex: number; resume: boolean }> = [];
      let dirtyA = false;
      for (const a of actions) {
        if (a.kind === "empty") {
          lines[a.lineIndex] = emptyLine();
          dirtyA = true;
        } else if (a.kind === "fresh") {
          const id = randomUUID();
          lines[a.lineIndex] = sendingLine(id);
          dirtyA = true;
          pending.push({ id, text: a.text, lineIndex: a.lineIndex, resume: false });
        } else {
          // resume: 라인은 이미 `sending <id>` — 그대로 두고 존재검사 후 종단.
          pending.push({ id: a.id!, text: a.text, lineIndex: a.lineIndex, resume: true });
        }
      }
      if (dirtyA) await atomicWrite(inboxPath, joinLines(lines, trailingNewline));

      // enqueue (resume 이고 이미 존재하면 스킵) → 성공분만 종단 후보.
      const finalize: Array<{ id: string; lineIndex: number }> = [];
      for (const p of pending) {
        try {
          if (p.resume && (await hasId(cfg.paths, p.id))) {
            finalize.push(p); // 이미 enqueue 됨 — 종단만
            continue;
          }
          await enqueue(cfg.paths, normalize(p.id, p.text));
          finalize.push(p);
        } catch (err) {
          // 필수 동작 실패 — 흡수 금지: 로그 후 sending 유지(재기동/다음 이벤트 재개).
          console.error(
            `[markdown] enqueue 오류 lane=${cfg.lane} id=${p.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Phase B: enqueue 확정분을 sent 로 종단.
      if (finalize.length > 0) {
        for (const f of finalize) lines[f.lineIndex] = sentLine(f.id);
        await atomicWrite(inboxPath, joinLines(lines, trailingNewline));
      }
    } finally {
      inboxBusy = false;
    }
  }

  async function handleApprovals(): Promise<void> {
    await withApprovalsLock(async () => {
      const content = await readMaybe(approvalsPath);
      if (content === null) return;
      if (lastSelfWrite.get(approvalsPath) === content) return; // 자기쓰기 echo

      const parsed = parseApprovals(content);
      for (const d of parsed.decisions) {
        const timer = permTimers.get(d.reqId);
        if (timer) {
          clearTimeout(timer);
          permTimers.delete(d.reqId);
        }
        for (const cb of decisionHandlers) cb(d.reqId, d.decision);
      }
      if (parsed.changed) await atomicWrite(approvalsPath, parsed.newContent);
    });
  }

  async function quarantine(filename: string, srcDir: string): Promise<void> {
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(join(srcDir, filename), join(quarantineDir, filename));
    } catch (err) {
      console.error(
        `[markdown] 충돌파일 격리 실패 ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleOut(filename: string): Promise<void> {
    if (!filename.endsWith(".out")) return;
    if (seenOut.has(filename)) return;
    seenOut.add(filename);
    try {
      const id = filename.replace(/\.out$/, "");
      const text = await readFile(join(cfg.paths.outDir, filename), "utf8");
      let replyRef: string | undefined;
      const sidecarRaw = await readMaybe(join(cfg.paths.outDir, `${id}.out.json`));
      if (sidecarRaw) {
        try {
          const sidecar = JSON.parse(sidecarRaw) as { reply_ref?: { channel_msg_id?: string } };
          replyRef = sidecar.reply_ref?.channel_msg_id;
        } catch {
          // sidecar 파손 → reply_ref 없이 진행(보조 정보).
        }
      }
      const header = replyRef ? `> ↩ ${replyRef}\n\n` : "";
      await atomicWrite(join(outboxDir, `${id}.md`), `${header}${text}`);
    } catch (err) {
      console.error(
        `[markdown] 출력 노트 쓰기 오류 ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function debounce(key: string, fn: () => void): void {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        fn();
      }, DEBOUNCE_MS),
    );
  }

  function watchDir(dir: string, onFile: (filename: string) => void): void {
    mkdirSync(dir, { recursive: true });
    const w = watch(dir, (_event, filename) => {
      if (!running || !filename) return;
      onFile(filename);
    });
    watchers.push(w);
  }

  function start(): void {
    if (!existsSync(rootDir)) {
      throw new Error(`[markdown] root 경로 없음: ${rootDir}`);
    }

    // A1: 제어 노트가 AI 작업폴더(cwd) 내부면 자기승인 위험 → fail-closed 기동 거부.
    const effectiveCwd =
      cfg.conf.cwd && cfg.conf.cwd.length > 0 ? resolve(cfg.conf.cwd) : process.cwd();
    const isInside = (child: string, parent: string): boolean => {
      const rel = relative(parent, child);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    for (const [name, p] of [
      ["inbox", inboxPath],
      ["approvals", approvalsPath],
      ["outbox", outboxDir],
    ] as const) {
      if (isInside(p, effectiveCwd)) {
        throw new Error(
          `[markdown] 제어 노트(${name})가 AI 작업폴더 내부에 있음: ${p} (cwd=${effectiveCwd}) — 자기승인 위험, cwd 밖으로 분리 필요`,
        );
      }
    }

    running = true;

    const inboxDir = dirname(inboxPath);
    const approvalsDir = dirname(approvalsPath);

    const dispatch = (srcDir: string, filename: string): void => {
      if (isConflictFile(filename)) {
        void quarantine(filename, srcDir);
        return;
      }
      const full = join(srcDir, filename);
      if (full === inboxPath) debounce(inboxPath, () => void handleInbox());
      else if (full === approvalsPath) debounce(approvalsPath, () => void handleApprovals());
    };

    // inbox·approvals 디렉터리(중복 제거) 감시.
    const dirs = new Set([inboxDir, approvalsDir]);
    for (const dir of dirs) watchDir(dir, (filename) => dispatch(dir, filename));

    // out 디렉터리 감시 → 마크다운 출력 노트.
    mkdirSync(cfg.paths.outDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    watchDir(cfg.paths.outDir, (filename) => {
      if (isConflictFile(filename)) return;
      debounce(`out:${filename}`, () => void handleOut(filename));
    });

    // 기동 시 기존 인박스/승인 노트 1회 처리(능동 세션 재개).
    void handleInbox();
    void handleApprovals();
  }

  function stop(): void {
    running = false;
    for (const w of watchers) w.close();
    watchers.length = 0;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    for (const t of permTimers.values()) clearTimeout(t);
    permTimers.clear();
  }

  async function requestPermission(req: PermRequest): Promise<void> {
    await withApprovalsLock(async () => {
      const existing = (await readMaybe(approvalsPath)) ?? "";
      const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      await atomicWrite(approvalsPath, existing + sep + renderApprovalBlock(req));
    });

    // 어댑터-로컬 타임아웃 — 무응답 시 노트 블록을 deny 로 종단(게이트도 독립 deny).
    const timer = setTimeout(() => {
      permTimers.delete(req.id);
      void withApprovalsLock(async () => {
        const content = await readMaybe(approvalsPath);
        if (content === null) return;
        const parsed = finalizeApprovalDeny(content, req.id, "timeout");
        if (parsed.changed) await atomicWrite(approvalsPath, parsed.newContent);
      });
      for (const cb of decisionHandlers) cb(req.id, "deny");
    }, DEFAULT_GATE_TIMEOUT_MS);
    permTimers.set(req.id, timer);
  }

  function onDecision(cb: DecisionCallback): void {
    decisionHandlers.push(cb);
  }

  return { start, stop, requestPermission, onDecision };
}
