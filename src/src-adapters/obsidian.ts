/**
 * Obsidian 소스 어댑터 — 파일 핸드셰이크(버튼 없는 채널).
 * 설계: docs/_internal/design/09-obsidian-source-adapter.md.
 * 인박스 노트 편집 + send 체크박스 → envelope → 큐.
 * 권한: approvals 노트에 ⏳ 블록 append → allow/deny 체크 감지 → 게이트 반영. 무응답 → 타임아웃 deny.
 * 출력: out/<id>.out 감시 → vault 출력 노트(one-file-per-message, atomic).
 * 동기 내성: *.sync-conflict* 격리·상태 마커 멱등 자기쓰기 가드·tmp→rename.
 */
import { watch, existsSync, mkdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import type { LaneConf } from "../shared/conf.js";
import { enqueue } from "../core/queue.js";
import type { Envelope } from "../shared/envelope.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import type { Source, DecisionCallback, Decision } from "./source.js";

const DEBOUNCE_MS = 150;

export interface ObsidianConfig {
  lane: string;
  proj: string;
  engine: string;
  paths: LanePaths;
  conf: LaneConf;
}

// --- 순수 파싱 (테스트 대상) -------------------------------------------------

/** 동기 충돌 파일 판별 — 파싱·실행 금지 대상. */
export function isConflictFile(filename: string): boolean {
  return /\.sync-conflict|conflicted copy|\.conflicted\./i.test(filename);
}

const SEND_BOX = /^\s*-\s*\[[ x]\]\s+.*\bsend\b/i;
const CHECKED_SEND = /^\s*-\s*\[x\]\s+.*\bsend\b/i;
const INBOX_TERMINAL = /^\s*-\s*\[x\]\s+.*\b(sent|empty)\b/i;

export interface InboxMessage {
  id: string;
  text: string;
  lineIndex: number;
}

export interface InboxParse {
  messages: InboxMessage[];
  lines: string[];
  trailingNewline: boolean;
  /** 빈 트리거 종단화 등으로 lines 가 이미 변경됐는지. */
  changed: boolean;
}

/**
 * 인박스 본문에서 actionable send 블록을 추출한다(파일은 쓰지 않음).
 * - 경계: send 체크박스(체크/미체크) 또는 종단 마커(sent/empty) 라인.
 * - 체크된 send 박스의 직전 세그먼트가 메시지. 빈 세그먼트는 즉시 종단 마킹(재발화 방지).
 * 호출자가 enqueue 성공 후 messages[].lineIndex 라인을 종단 마커로 재작성한다.
 */
export function parseInbox(content: string, genId: () => string): InboxParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const messages: InboxMessage[] = [];
  let segmentStart = 0;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (INBOX_TERMINAL.test(line)) {
      segmentStart = i + 1;
      continue;
    }

    if (SEND_BOX.test(line)) {
      if (CHECKED_SEND.test(line)) {
        const text = lines.slice(segmentStart, i).join("\n").trim();
        if (text.length > 0) {
          const id = genId();
          messages.push({ id, text, lineIndex: i });
        } else {
          lines[i] = "- [x] ⚠️ empty (no message)";
          changed = true;
        }
      }
      segmentStart = i + 1;
    }
  }

  return { messages, lines, trailingNewline, changed };
}

/** 인박스 send 트리거 라인을 종단(sent) 마커로 재작성. */
export function inboxTerminalLine(id: string): string {
  return `- [x] ✅ sent ${id}`;
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

/** vault 상대 경로를 절대경로로 해소한다. 필수 키 누락 시 throw(fail-closed). */
function resolvePaths(conf: LaneConf): {
  vaultRoot: string;
  inboxPath: string;
  approvalsPath: string;
  outboxDir: string;
  quarantineDir: string;
} {
  if (!conf.vault) throw new Error("[obsidian] conf.vault 누락 — vault 절대경로 필수");
  if (!conf.inbox) throw new Error("[obsidian] conf.inbox 누락 — 입력 노트(vault 상대) 필수");
  const vaultRoot = conf.vault;
  const inboxPath = join(vaultRoot, conf.inbox);
  const inboxDir = dirname(inboxPath);
  const approvalsPath = conf.approvals
    ? join(vaultRoot, conf.approvals)
    : join(inboxDir, "approvals.md");
  const outboxDir = conf.outbox ? join(vaultRoot, conf.outbox) : join(inboxDir, "out");
  const quarantineDir = join(inboxDir, ".conflicts");
  return { vaultRoot, inboxPath, approvalsPath, outboxDir, quarantineDir };
}

export function createObsidianSource(cfg: ObsidianConfig): Source {
  const { vaultRoot, inboxPath, approvalsPath, outboxDir, quarantineDir } = resolvePaths(cfg.conf);

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

  function normalize(msg: InboxMessage): Envelope {
    return {
      v: 1,
      id: msg.id,
      lane: cfg.lane,
      source: "obsidian",
      backend: "acp",
      engine: cfg.engine,
      project: cfg.proj,
      ts: new Date().toISOString(),
      text: msg.text,
      reply_ref: { channel_msg_id: msg.id },
    };
  }

  async function readMaybe(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async function handleInbox(): Promise<void> {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const content = await readMaybe(inboxPath);
      if (content === null) return;
      if (lastSelfWrite.get(inboxPath) === content) return; // 자기쓰기 echo

      const parsed = parseInbox(content, randomUUID);
      let dirty = parsed.changed;

      for (const m of parsed.messages) {
        try {
          await enqueue(cfg.paths, normalize(m));
          parsed.lines[m.lineIndex] = inboxTerminalLine(m.id);
          dirty = true;
        } catch (err) {
          // 필수 동작 실패 — 흡수 금지: 로그 후 트리거 미종단(다음 이벤트 재시도).
          console.error(
            `[obsidian] enqueue 오류 lane=${cfg.lane}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (dirty) {
        const next = parsed.lines.join("\n") + (parsed.trailingNewline ? "\n" : "");
        await atomicWrite(inboxPath, next);
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
        `[obsidian] 충돌파일 격리 실패 ${filename}: ${err instanceof Error ? err.message : String(err)}`,
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
        `[obsidian] 출력 노트 쓰기 오류 ${filename}: ${err instanceof Error ? err.message : String(err)}`,
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
    if (!existsSync(vaultRoot)) {
      throw new Error(`[obsidian] vault 경로 없음: ${vaultRoot}`);
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

    // out 디렉터리 감시 → vault 출력 노트.
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
