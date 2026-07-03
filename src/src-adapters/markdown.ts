/**
 * Markdown 소스 어댑터 — 파일 핸드셰이크(버튼 없는 채널).
 * 임의 마크다운 에디터/동기 도구(대표 예: Obsidian)에서 노트 파일 편집만으로 구동.
 * 설계: docs/_internal/design/09-markdown-source-adapter.md.
 * 인박스 노트 편집 + send 체크박스 → envelope → 큐.
 * 권한: approvals 노트에 ⏳ 블록 append → allow/deny 체크 감지 → 게이트 반영. 무응답 → 타임아웃 deny.
 * 출력: out/<id>.out 감시 → 마크다운 출력 노트(one-file-per-message, atomic).
 * 동기 내성: *.sync-conflict* 격리·상태 마커 멱등 자기쓰기 가드·tmp→rename.
 */
import { watch, existsSync, mkdirSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, rename, mkdir, stat, readdir } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import type { LaneConf } from "../shared/conf.js";
import { enqueue, hasId } from "../core/queue.js";
import type { Envelope } from "../shared/envelope.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import type { Source, DecisionCallback, Decision } from "./source.js";
import { formatException } from "../shared/notify.js";

/** enqueue 연속 실패 임계 — 도달 시 outbox 에 1회 알림(telegram 패턴과 일관, ⑫). */
const ENQUEUE_FAIL_THRESHOLD = 3;

const DEBOUNCE_MS = 150;
/** fs.watch 가 놓친 편집을 보정하는 저빈도 폴링 주기(B2 백스톱). */
const POLL_INTERVAL_MS = 2_000;
/** 내용 안정화 재확인 간격(B1) — 동기 중 잘린 파일 읽기 방지. */
const READ_SETTLE_MS = 50;

export interface MarkdownConfig {
  lane: string;
  proj: string;
  engine: string;
  paths: LanePaths;
  conf: LaneConf;
  /** 인바운드 enqueue 직후 호출(injector 깨우기). in-process 신호 — watch 불요(DEC-001). */
  onInbound?: (() => void) | undefined;
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
        actions.push(
          text.length > 0
            ? { kind: "fresh", text, lineIndex: i }
            : { kind: "empty", text: "", lineIndex: i },
        );
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
            lines[j] = lines[j]!.replace(
              /^###\s+⏳/,
              `### ${decision === "allow" ? "✅" : "⛔"}`,
            ).replace(/\breq\b/, `req(${decision})`);
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
export function finalizeApprovalDeny(
  content: string,
  reqId: string,
  reason: string,
): ApprovalsParse {
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
  approvalsDir: string;
  outboxDir: string;
  quarantineDir: string;
} {
  if (!conf.root) throw new Error("[markdown] conf.root 누락 — 마크다운 루트 절대경로 필수");
  if (!conf.inbox) throw new Error("[markdown] conf.inbox 누락 — 입력 노트(root 상대) 필수");
  const rootDir = conf.root;
  const inboxPath = join(rootDir, conf.inbox);
  const inboxDir = dirname(inboxPath);
  // 승인은 요청당 파일 디렉터리(D, 백로그 B3) — conf.approvals 는 디렉터리(미지정 시 inbox 형제 approvals/).
  const approvalsDir = conf.approvals ? join(rootDir, conf.approvals) : join(inboxDir, "approvals");
  const outboxDir = conf.outbox ? join(rootDir, conf.outbox) : join(inboxDir, "out");
  const quarantineDir = join(inboxDir, ".conflicts");
  return { rootDir, inboxPath, approvalsDir, outboxDir, quarantineDir };
}

export function createMarkdownSource(cfg: MarkdownConfig): Source {
  const { rootDir, inboxPath, approvalsDir, outboxDir, quarantineDir } = resolvePaths(cfg.conf);

  const decisionHandlers: DecisionCallback[] = [];
  const watchers: FSWatcher[] = [];
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSelfWrite = new Map<string, string>();
  // 폴링 백스톱(B2): 파일별 마지막 관측 시그니처(mtimeMs:size)와 인터벌·in-flight 추적.
  const lastFileSig = new Map<string, string>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollBusy = false;
  let pollOp: Promise<void> = Promise.resolve();
  let inboxBusy = false;
  let running = false;
  // enqueue 연속 실패 추적(⑫) — 임계 도달 시 outbox 알림 1회, 성공 시 리셋.
  let consecutiveEnqueueFailures = 0;
  let enqueueAlertSent = false;
  // approvals 파일 변경을 직렬화(append·결정 재작성·타임아웃 경합 방지).
  let approvalsLock: Promise<void> = Promise.resolve();
  // in-flight inbox/approvals 처리 추적 — stop() 이 정리 완료를 대기(H4/DEC-004).
  let inboxOp: Promise<void> = Promise.resolve();
  let approvalsOp: Promise<void> = Promise.resolve();

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

  /**
   * 내용 안정화 후 읽기(B1) — 짧은 간격 2회 read 가 동일할 때만 반환. 동기 중 절반만
   * 기록된 파일을 읽어 잘린 메시지를 보내는 것을 막는다. 변경 진행 중이면 null(다음
   * watch/폴 이벤트가 안정된 상태로 재시도). atomic-rename 저장은 즉시 안정이라 지연 없음.
   */
  async function readStable(filePath: string): Promise<string | null> {
    const first = await readMaybe(filePath);
    if (first === null) return null;
    await new Promise((r) => setTimeout(r, READ_SETTLE_MS));
    const second = await readMaybe(filePath);
    if (second === null || second !== first) return null;
    return second;
  }

  function joinLines(lines: string[], trailingNewline: boolean): string {
    return lines.join("\n") + (trailingNewline ? "\n" : "");
  }

  async function handleInbox(): Promise<void> {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const content = await readStable(inboxPath);
      if (content === null) return; // 부재 또는 변경 진행 중(B1) — 다음 이벤트 재시도
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
          consecutiveEnqueueFailures = 0; // 성공 → 연속 실패 리셋
          enqueueAlertSent = false;
        } catch (err) {
          // 필수 동작 실패 — 흡수 금지: 로그 후 sending 유지(재기동/다음 이벤트 재개).
          consecutiveEnqueueFailures++;
          console.error(
            `[markdown] enqueue 오류(${consecutiveEnqueueFailures}회 연속) lane=${cfg.lane} id=${p.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // 임계 도달 시 1회 운영자 알림(⑫) — telegram 패턴과 일관.
          if (consecutiveEnqueueFailures >= ENQUEUE_FAIL_THRESHOLD && !enqueueAlertSent) {
            enqueueAlertSent = true;
            await alertEnqueueFailure(consecutiveEnqueueFailures);
          }
        }
      }

      // Phase B: enqueue 확정분을 sent 로 종단.
      if (finalize.length > 0) {
        for (const f of finalize) lines[f.lineIndex] = sentLine(f.id);
        await atomicWrite(inboxPath, joinLines(lines, trailingNewline));
        cfg.onInbound?.(); // injector 깨우기(in-process)
      }
    } finally {
      inboxBusy = false;
    }
  }

  async function handleApprovals(): Promise<void> {
    await withApprovalsLock(async () => {
      let entries: string[];
      try {
        entries = await readdir(approvalsDir);
      } catch {
        return; // 디렉터리 부재 — 아직 요청 없음
      }
      for (const fn of entries) {
        if (!fn.endsWith(".md")) continue;
        if (isConflictFile(fn)) {
          await quarantine(fn, approvalsDir);
          continue;
        }
        const file = join(approvalsDir, fn);
        const content = await readStable(file);
        if (content === null) continue; // 부재 또는 변경 진행 중(B1)
        if (lastSelfWrite.get(file) === content) continue; // 자기쓰기 echo

        const parsed = parseApprovals(content);
        for (const d of parsed.decisions) {
          const timer = permTimers.get(d.reqId);
          if (timer) {
            clearTimeout(timer);
            permTimers.delete(d.reqId);
          }
          for (const cb of decisionHandlers) cb(d.reqId, d.decision);
        }
        if (parsed.changed) await atomicWrite(file, parsed.newContent);
      }
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

  /** out/<id>.out (+ sidecar) → 출력 노트. injector 가 writeOut 직후 in-process 호출(DEC-001). */
  /** enqueue 연속 실패 임계 도달 시 outbox 에 1회 액션형 알림 노트(⑫). 채널이 파일이라 outbox 로 표면화. */
  async function alertEnqueueFailure(count: number): Promise<void> {
    const note = formatException({
      situation: `수신 메시지 큐 적재(enqueue)가 연속 ${count}회 실패했습니다`,
      action:
        "서버 디스크 용량과 state 디렉터리 권한을 확인하세요. 해소 전까지 인박스 지시가 처리되지 않을 수 있습니다.",
    });
    await atomicWrite(join(outboxDir, "_enqueue-alert.md"), note).catch((e: unknown) =>
      console.error(
        `[markdown] enqueue 실패 알림 기록 오류: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  async function renderOut(id: string): Promise<void> {
    const text = await readFile(join(cfg.paths.outDir, `${id}.out`), "utf8");
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
  }

  /** handleInbox 를 추적 가능한 형태로 기동(fire-and-forget + .catch, stop 대기 대상). */
  function runInbox(): void {
    inboxOp = handleInbox().catch((err: unknown) =>
      console.error(
        `[markdown] inbox 처리 오류: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  /** handleApprovals 를 추적 가능한 형태로 기동. */
  function runApprovals(): void {
    approvalsOp = handleApprovals().catch((err: unknown) =>
      console.error(
        `[markdown] approvals 처리 오류: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
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

  /** 파일 시그니처(mtimeMs:size) — 부재 시 null. mtime 1초 granularity 보완 위해 size 동반. */
  async function fileSig(filePath: string): Promise<string | null> {
    try {
      const s = await stat(filePath);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  /**
   * 디렉터리 시그니처 — `.md` 파일별 mtime:size 집계(내용 변경 감지). 디렉터리 mtime 만으로는
   * 파일 내용 변경(체크박스 토글)을 못 잡으므로 항목별 stat 으로 구성. 부재 시 null.
   */
  async function dirSig(dir: string): Promise<string | null> {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return null;
    }
    const parts: string[] = [];
    for (const f of files) {
      const s = await fileSig(join(dir, f));
      if (s !== null) parts.push(`${f}:${s}`);
    }
    return parts.join("|");
  }

  /** 기동 시 inbox baseline 시그니처 seed(첫 폴의 불필요 재트리거 방지). 부재면 다음 폴이 생성 감지. */
  function seedSig(filePath: string): void {
    try {
      const s = statSync(filePath);
      lastFileSig.set(filePath, `${s.mtimeMs}:${s.size}`);
    } catch {
      // 부재 — seed 생략
    }
  }

  /**
   * 폴링 백스톱 1회(B2): inbox 파일·approvals 디렉터리 시그니처 변화 시 watch 와 동일한 debounce
   * 핸들러 트리거. watch 가 놓친 이벤트를 보정. 핸들러의 self-write·busy 가드가 중복을 멱등 흡수.
   */
  async function pollOnce(): Promise<void> {
    if (!running || pollBusy) return;
    pollBusy = true;
    try {
      const inboxSig = await fileSig(inboxPath);
      if (inboxSig !== null && lastFileSig.get(inboxPath) !== inboxSig) {
        lastFileSig.set(inboxPath, inboxSig);
        debounce(inboxPath, runInbox);
      }
      const apprSig = await dirSig(approvalsDir);
      if (apprSig !== null && lastFileSig.get(approvalsDir) !== apprSig) {
        lastFileSig.set(approvalsDir, apprSig);
        debounce(approvalsDir, runApprovals);
      }
    } finally {
      pollBusy = false;
    }
  }

  function start(): void {
    if (!existsSync(rootDir)) {
      throw new Error(`[markdown] root 경로 없음: ${rootDir}`);
    }

    // 입력 검증(C): 상대 경로(inbox/approvals/outbox)는 root 안에 머물러야 한다 — '..'·절대경로로
    // root 를 탈출하면 임의 위치 읽기/쓰기 위험 → fail-closed 기동 거부.
    for (const [name, rel] of [
      ["inbox", cfg.conf.inbox],
      ["approvals", cfg.conf.approvals],
      ["outbox", cfg.conf.outbox],
    ] as const) {
      if (rel === undefined) continue;
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
        throw new Error(`[markdown] ${name} 경로는 root 상대여야 하며 '..'·절대경로 금지: ${rel}`);
      }
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
      ["approvals", approvalsDir],
      ["outbox", outboxDir],
    ] as const) {
      if (isInside(p, effectiveCwd)) {
        throw new Error(
          `[markdown] 제어 노트(${name})가 AI 작업폴더 내부에 있음: ${p} (cwd=${effectiveCwd}) — 자기승인 위험, cwd 밖으로 분리 필요`,
        );
      }
    }

    // 상호 배타: 승인/출력/입력/격리 경로가 같거나 포함 관계면 자기쓰기 재발화·승인
    // 오파싱 위험(출력·알림 노트가 승인 감시에 잡힘) → fail-closed 기동 거부.
    // macOS 기본 FS 는 대소문자 무시라 Shared/shared 가 같은 물리 디렉터리 — darwin 은
    // 소문자 정규화 후 비교한다(대소문자 구분 볼륨에선 과차단이나 fail-closed 방향이라 수용).
    const normCase = (p: string): string => (process.platform === "darwin" ? p.toLowerCase() : p);
    const overlaps = (a: string, b: string): boolean =>
      isInside(normCase(a), normCase(b)) || isInside(normCase(b), normCase(a));
    const rApprovals = resolve(approvalsDir);
    const rOutbox = resolve(outboxDir);
    const rInbox = resolve(inboxPath);
    const rQuarantine = resolve(quarantineDir);
    for (const [nameA, a, nameB, b] of [
      ["approvals", rApprovals, "outbox", rOutbox],
      ["approvals", rApprovals, "quarantine(.conflicts)", rQuarantine],
      ["outbox", rOutbox, "quarantine(.conflicts)", rQuarantine],
    ] as const) {
      if (overlaps(a, b)) {
        throw new Error(
          `[markdown] ${nameA}(${a})와 ${nameB}(${b})가 같거나 포함 관계 — 출력·알림·격리 노트가 승인/입력 감시에 잡힙니다. 경로를 분리하세요.`,
        );
      }
    }
    for (const [name, dir] of [
      ["approvals", rApprovals],
      ["outbox", rOutbox],
    ] as const) {
      if (isInside(normCase(rInbox), normCase(dir))) {
        throw new Error(
          `[markdown] 입력 노트(${rInbox})가 ${name} 디렉터리(${dir}) 내부 — 입력/제어 경로가 겹칩니다. 경로를 분리하세요.`,
        );
      }
    }

    running = true;

    const inboxDir = dirname(inboxPath);

    const dispatch = (srcDir: string, filename: string): void => {
      if (isConflictFile(filename)) {
        void quarantine(filename, srcDir);
        return;
      }
      const full = join(srcDir, filename);
      if (full === inboxPath) debounce(inboxPath, () => runInbox());
      else if (srcDir === approvalsDir && filename.endsWith(".md")) {
        debounce(approvalsDir, () => runApprovals());
      }
    };

    // inbox 디렉터리 + approvals 요청당-파일 디렉터리 감시.
    const dirs = new Set([inboxDir, approvalsDir]);
    for (const dir of dirs) watchDir(dir, (filename) => dispatch(dir, filename));

    // out 렌더는 injector 가 renderOut() 으로 in-process 호출(out/ watch 제거, DEC-001).
    mkdirSync(cfg.paths.outDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });

    // 기동 시 기존 인박스/승인 노트 1회 처리(능동 세션 재개).
    runInbox();
    runApprovals();

    // 폴링 백스톱(B2): watch 가 이벤트를 놓쳐도 주기적으로 보정. inbox baseline seed 후 인터벌 시작.
    // approvals 는 디렉터리라 첫 폴에서 시그니처를 seed(첫 폴 1회 스캔은 멱등이라 무해).
    seedSig(inboxPath);
    pollTimer = setInterval(() => {
      pollOp = pollOnce().catch((err: unknown) =>
        console.error(`[markdown] 폴링 오류: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, POLL_INTERVAL_MS);
  }

  async function stop(): Promise<void> {
    running = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const w of watchers) w.close();
    watchers.length = 0;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    for (const t of permTimers.values()) clearTimeout(t);
    permTimers.clear();
    // in-flight 처리(폴 + approvals 락 체인 + inbox/approvals op) settle 대기 —
    // 임시 디렉터리 정리 뒤 살아남은 쓰기가 ENOENT 를 내지 않도록(H4).
    await pollOp.catch(() => {});
    await approvalsLock.catch(() => {});
    await inboxOp.catch(() => {});
    await approvalsOp.catch(() => {});
  }

  /**
   * 요청당 승인 파일 경로(D). reqId 는 엔진이 통제하는 sessionId 이므로(client.ts) 경로 탈출 차단:
   * 승인 파일은 approvalsDir 의 *직속 자식* 이어야 한다 — `..`·`/` 등이 섞이면 fail-closed throw
   * (게이트가 sendPermPrompt throw 를 deny 로 처리). AI 가 승인 노트를 임의 경로에 위조하는 것을 막는다.
   */
  function approvalFile(reqId: string): string {
    const file = resolve(approvalsDir, `${reqId}.md`);
    if (dirname(file) !== resolve(approvalsDir)) {
      throw new Error(`잘못된 승인 요청 id "${reqId}" — 경로 탈출 차단(fail-closed deny).`);
    }
    return file;
  }

  async function requestPermission(req: PermRequest): Promise<void> {
    // 요청당 파일(D, 백로그 B3) — 단일 파일 append 대신 격리해 동시 편집 충돌면 축소.
    await withApprovalsLock(async () => {
      await atomicWrite(approvalFile(req.id), renderApprovalBlock(req));
    });

    // 어댑터-로컬 타임아웃 — 무응답 시 해당 요청 파일을 deny 로 종단(게이트도 독립 deny).
    const timer = setTimeout(() => {
      permTimers.delete(req.id);
      void withApprovalsLock(async () => {
        const file = approvalFile(req.id);
        const content = await readMaybe(file);
        if (content === null) return;
        const parsed = finalizeApprovalDeny(content, req.id, "timeout");
        if (parsed.changed) await atomicWrite(file, parsed.newContent);
      });
      for (const cb of decisionHandlers) cb(req.id, "deny");
    }, DEFAULT_GATE_TIMEOUT_MS);
    permTimers.set(req.id, timer);
  }

  function onDecision(cb: DecisionCallback): void {
    decisionHandlers.push(cb);
  }

  /**
   * Source 계약: 운영 알림 — outbox 의 _adde-notice.md 에 시각과 함께 append
   * (채널이 파일이라 노트로 표면화. outbox 는 인바운드 감시 밖이라 자기쓰기 루프 없음).
   */
  async function notify(text: string): Promise<void> {
    const file = join(outboxDir, "_adde-notice.md");
    const existing = (await readMaybe(file)) ?? "";
    const stamp = new Date().toISOString();
    await atomicWrite(file, `${existing}${existing ? "\n" : ""}> ${stamp}\n\n${text}\n`);
  }

  return { start, stop, requestPermission, onDecision, renderOut, notify };
}
