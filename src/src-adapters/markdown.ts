/**
 * Markdown 소스 어댑터 — 파일 핸드셰이크(버튼 없는 채널).
 * 임의 마크다운 에디터/동기 도구(대표 예: Obsidian)에서 노트 파일 편집만으로 구동.
 * 설계: docs/_internal/design/09-markdown-source-adapter.md.
 * 인박스 노트 편집 + send 체크박스 → envelope → 큐.
 * 권한: approvals 노트에 ⏳ 블록 append → allow/deny 체크 감지 → 게이트 반영. 무응답 → 타임아웃 deny.
 * 출력: out/<id>.out 감시 → 마크다운 출력 노트(one-file-per-message, atomic).
 * 동기 내성: *.sync-conflict* 격리·상태 마커 멱등 자기쓰기 가드·tmp→rename.
 */
import { t, tFor } from "../shared/i18n.js";
import { errMsg } from "../shared/errors.js";
import { watch, existsSync, mkdirSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, rename, mkdir, stat, readdir } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import { isPathInside, normCasePath, pathsOverlap } from "../shared/paths.js";
import { atomicWrite as atomicWriteFile } from "../shared/fs-atomic.js";
import type { LaneConf } from "../shared/conf.js";
import { enqueue, hasId, readSidecar } from "../core/queue.js";
import type { Envelope } from "../shared/envelope.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import type { Source, DecisionCallback, Decision } from "./source.js";
import { ENQUEUE_FAIL_THRESHOLD } from "./source.js";
import { formatException } from "../shared/notify.js";
import type { NotifyT } from "../shared/notify.js";

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

// --- 전송 스탬프 (DEC-001/003/007) -------------------------------------------
// 형식 `YYYYMMDD-HHmmss`(로컬 시각) — 파일명 안전(콜론 없음)하면서 inbox 마커와
// out 노트 파일명에 동일 표기. 기준 시각은 전송(enqueue) 시각이며 envelope.ts 로
// 영속돼 재렌더에도 파일명이 결정론적이다.

/** 전송 스탬프 표기 — 로컬 시각 `YYYYMMDD-HHmmss`. */
export function formatStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** ISO 타임스탬프(envelope.ts/sidecar)로부터 스탬프 도출. */
export function stampFromIso(iso: string): string {
  return formatStamp(new Date(iso));
}

/** out 응답 노트 basename(확장자 제외) — sent 위키링크 텍스트와 동일해야 한다. */
export function outNoteBase(stamp: string, id: string): string {
  return `${stamp} ${id}`;
}

/**
 * 스탬프를 로컬 시각으로 되돌려 ISO 로 복원 — 재개(re-enqueue) 시 envelope.ts 가
 * sending 라인의 스탬프와 같은 값을 재현해야 sent 위키링크와 노트 파일명이 일치한다.
 * 형식 불일치(구버전 라인 등)면 null.
 */
export function isoFromStamp(stamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 인박스 액션 — main 이 id 부여·enqueue·종단 마킹을 수행. */
export interface InboxAction {
  /** fresh=신규 트리거(새 id 필요) · resume=`sending <id>` 재개 · empty=빈 트리거. */
  kind: "fresh" | "resume" | "empty";
  lineIndex: number;
  text: string;
  /** resume 시 기존 id. */
  id?: string;
  /** resume 시 sending 라인에 기록된 전송 스탬프(구버전 라인엔 없음). */
  stamp?: string;
}

export interface InboxParse {
  actions: InboxAction[];
  lines: string[];
  trailingNewline: boolean;
}

/** send 트리거 라인을 단계별 마커로 재작성하는 헬퍼(A3 2단계 내구 마킹). */
// 스탬프는 id 뒤에 둔다(DEC-004) — 재개 파서가 sending 다음 첫 토큰을 id 로 읽는다.
export function sendingLine(id: string, stamp: string): string {
  return `- [x] ⏳ sending ${id} ${stamp}`;
}
// 위키링크 텍스트 = out 노트 basename(스탬프+id) — 노트 생성 시 링크가 해소된다(DEC-005).
export function sentLine(id: string, stamp: string): string {
  return `- [x] ✅ sent [[${outNoteBase(stamp, id)}]]`;
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
      const m = /sending\s+(\S+)(?:\s+(\S+))?/i.exec(label);
      if (m) {
        const action: InboxAction = { kind: "resume", id: m[1]!, text: segment(i), lineIndex: i };
        if (m[2]) action.stamp = m[2];
        actions.push(action);
      }
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
// now 주입: 요청 시각·자동 deny 기한 표기(테스트 결정론 확보). 기한은 게이트 타임아웃과 동일 기준.
export function renderApprovalBlock(
  req: PermRequest,
  tl: NotifyT = t,
  now: Date = new Date(),
): string {
  const detail = req.detail.replace(/\s+/g, " ").trim();
  const deadline = new Date(now.getTime() + DEFAULT_GATE_TIMEOUT_MS);
  return [
    `### ⏳ req ${req.id} · ${req.tool}`,
    `> ${detail}  (cwd: ${req.cwd})`,
    `> ${tl("markdown.approvalMeta", { requested: formatStamp(now), deadline: formatStamp(deadline) })}`,
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
  if (!conf.root) throw new Error(t("markdown.confRootMissing"));
  if (!conf.inbox) throw new Error(t("markdown.confInboxMissing"));
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
  const tl = tFor(cfg.conf.lang);
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

  /** 원자 기록(shared 위임) + 자기쓰기 echo 가드 등록. */
  async function atomicWrite(filePath: string, content: string): Promise<void> {
    await atomicWriteFile(filePath, content);
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

  // ts 는 전송 스탬프의 원본(SoT) — 호출자가 스탬프와 같은 순간의 값을 넘긴다(DEC-003).
  function normalize(id: string, text: string, ts: string): Envelope {
    return {
      v: 1,
      id,
      lane: cfg.lane,
      source: "markdown",
      backend: "acp",
      engine: cfg.engine,
      project: cfg.proj,
      ts,
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
      const pending: Array<{
        id: string;
        text: string;
        lineIndex: number;
        resume: boolean;
        stamp: string;
        ts: string;
      }> = [];
      let dirtyA = false;
      for (const a of actions) {
        if (a.kind === "empty") {
          lines[a.lineIndex] = emptyLine();
          dirtyA = true;
        } else if (a.kind === "fresh") {
          const id = randomUUID();
          const d = new Date();
          const stamp = formatStamp(d);
          lines[a.lineIndex] = sendingLine(id, stamp);
          dirtyA = true;
          pending.push({
            id,
            text: a.text,
            lineIndex: a.lineIndex,
            resume: false,
            stamp,
            ts: d.toISOString(),
          });
        } else {
          // resume: 라인은 이미 `sending <id> [<stamp>]` — 스탬프를 라인에서 복원해
          // sent 링크·envelope.ts 와 일치시킨다. 구버전 라인(스탬프 없음)은 now 폴백.
          const d = new Date();
          const stamp = a.stamp ?? formatStamp(d);
          const ts = (a.stamp ? isoFromStamp(a.stamp) : null) ?? d.toISOString();
          pending.push({
            id: a.id!,
            text: a.text,
            lineIndex: a.lineIndex,
            resume: true,
            stamp,
            ts,
          });
        }
      }
      if (dirtyA) await atomicWrite(inboxPath, joinLines(lines, trailingNewline));

      // enqueue (resume 이고 이미 존재하면 스킵) → 성공분만 종단 후보.
      const finalize: Array<{ id: string; lineIndex: number; stamp: string }> = [];
      for (const p of pending) {
        try {
          if (p.resume && (await hasId(cfg.paths, p.id))) {
            finalize.push(p); // 이미 enqueue 됨 — 종단만
            continue;
          }
          await enqueue(cfg.paths, normalize(p.id, p.text, p.ts));
          finalize.push(p);
          consecutiveEnqueueFailures = 0; // 성공 → 연속 실패 리셋
          enqueueAlertSent = false;
        } catch (err) {
          // 필수 동작 실패 — 흡수 금지: 로그 후 sending 유지(재기동/다음 이벤트 재개).
          consecutiveEnqueueFailures++;
          console.error(
            t("log.markdown.enqueueError", {
              count: consecutiveEnqueueFailures,
              lane: cfg.lane,
              id: p.id,
              error: errMsg(err),
            }),
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
        for (const f of finalize) lines[f.lineIndex] = sentLine(f.id, f.stamp);
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
        t("log.markdown.quarantineFail", {
          filename,
          error: errMsg(err),
        }),
      );
    }
  }

  /** out/<id>.out (+ sidecar) → 출력 노트. injector 가 writeOut 직후 in-process 호출(DEC-001). */
  /** enqueue 연속 실패 임계 도달 시 outbox 에 1회 액션형 알림 노트(⑫). 채널이 파일이라 outbox 로 표면화. */
  async function alertEnqueueFailure(count: number): Promise<void> {
    const note = formatException(
      {
        situation: tl("markdown.enqueueFail.situation", { count }),
        action: tl("markdown.enqueueFail.action"),
      },
      tl,
    );
    await atomicWrite(join(outboxDir, "_enqueue-alert.md"), note).catch((e: unknown) =>
      console.error(t("log.markdown.alertWriteError", { error: errMsg(e) })),
    );
  }

  async function renderOut(id: string): Promise<void> {
    const text = await readFile(join(cfg.paths.outDir, `${id}.out`), "utf8");
    // sidecar 읽기는 queue.readSidecar 로 일원화(부재·파손 → null = 메타 없이 진행).
    const sidecar = await readSidecar(cfg.paths, id);
    // 파일명 스탬프는 전송 시각(origin_ts) 유래 — 재렌더에도 결정론적(DEC-003).
    // origin_ts 부재(구버전 sidecar)는 종전 `<id>.md` 유지.
    const stamp = sidecar?.origin_ts ? stampFromIso(sidecar.origin_ts) : null;
    const noteName = stamp ? `${outNoteBase(stamp, id)}.md` : `${id}.md`;
    const headerLines: string[] = [];
    const replyRef = sidecar?.reply_ref?.channel_msg_id;
    if (replyRef) headerLines.push(`> ↩ ${replyRef}`);
    if (sidecar?.question) headerLines.push(`> ❓ ${sidecar.question}`);
    if (stamp && sidecar?.ts) {
      headerLines.push(
        `> ${tl("markdown.outMeta", { sent: stamp, done: stampFromIso(sidecar.ts) })}`,
      );
    }
    const header = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";
    await atomicWrite(join(outboxDir, noteName), `${header}${text}`);
  }

  /** handleInbox 를 추적 가능한 형태로 기동(fire-and-forget + .catch, stop 대기 대상). */
  function runInbox(): void {
    inboxOp = handleInbox().catch((err: unknown) =>
      console.error(t("log.markdown.inboxError", { error: errMsg(err) })),
    );
  }

  /** handleApprovals 를 추적 가능한 형태로 기동. */
  function runApprovals(): void {
    approvalsOp = handleApprovals().catch((err: unknown) =>
      console.error(
        t("log.markdown.approvalsError", {
          error: errMsg(err),
        }),
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
      // 충돌 파일 격리 백스톱: inbox 파일 시그니처·approvals 시그니처는 "충돌 파일 생성" 을
      // 포착하지 못하므로(watch 가 생성 이벤트를 놓치면 영구 방치) 인박스 디렉터리를 직접 스캔.
      try {
        const entries = await readdir(dirname(inboxPath));
        for (const fn of entries) {
          if (isConflictFile(fn)) await quarantine(fn, dirname(inboxPath));
        }
      } catch {
        // 디렉터리 부재 — 다음 폴에서 재시도
      }
    } finally {
      pollBusy = false;
    }
  }

  function start(): void {
    if (!existsSync(rootDir)) {
      throw new Error(t("markdown.rootNotFound", { path: rootDir }));
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
        throw new Error(t("markdown.pathNotRelative", { name, rel }));
      }
    }

    // A1: 제어 노트가 AI 작업폴더(cwd) 내부면 자기승인 위험 → fail-closed 기동 거부.
    const effectiveCwd =
      cfg.conf.cwd && cfg.conf.cwd.length > 0 ? resolve(cfg.conf.cwd) : process.cwd();
    for (const [name, p] of [
      ["inbox", inboxPath],
      ["approvals", approvalsDir],
      ["outbox", outboxDir],
    ] as const) {
      if (isPathInside(p, effectiveCwd)) {
        throw new Error(t("markdown.controlNoteInCwd", { name, path: p, cwd: effectiveCwd }));
      }
    }

    // 상호 배타: 승인/출력/입력/격리 경로가 같거나 포함 관계면 자기쓰기 재발화·승인
    // 오파싱 위험(출력·알림 노트가 승인 감시에 잡힘) → fail-closed 기동 거부.
    // 판정 규칙은 lane-config 의 생성 시 사전 경고와 동일해야 한다 — shared/paths 가 SSOT.
    const rApprovals = resolve(approvalsDir);
    const rOutbox = resolve(outboxDir);
    const rInbox = resolve(inboxPath);
    const rQuarantine = resolve(quarantineDir);
    for (const [nameA, a, nameB, b] of [
      ["approvals", rApprovals, "outbox", rOutbox],
      ["approvals", rApprovals, "quarantine(.conflicts)", rQuarantine],
      ["outbox", rOutbox, "quarantine(.conflicts)", rQuarantine],
    ] as const) {
      if (pathsOverlap(a, b)) {
        throw new Error(t("markdown.pathsOverlap", { nameA, a, nameB, b }));
      }
    }
    for (const [name, dir] of [
      ["approvals", rApprovals],
      ["outbox", rOutbox],
    ] as const) {
      if (isPathInside(normCasePath(rInbox), normCasePath(dir))) {
        throw new Error(t("markdown.inboxInsideDir", { inbox: rInbox, name, dir }));
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
        console.error(t("log.markdown.pollError", { error: errMsg(err) })),
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
      throw new Error(t("markdown.badApprovalId", { reqId }));
    }
    return file;
  }

  async function requestPermission(req: PermRequest): Promise<void> {
    // 요청당 파일(D, 백로그 B3) — 단일 파일 append 대신 격리해 동시 편집 충돌면 축소.
    await withApprovalsLock(async () => {
      await atomicWrite(approvalFile(req.id), renderApprovalBlock(req, tl));
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
