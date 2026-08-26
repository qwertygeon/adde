/**
 * 투영기(L1) — 이벤트 기록에서만 파생하는 결정론적 노트 렌더(FR-015·FR-018·FR-019·FR-034·FR-036·FR-040).
 * 출력 소유를 Surface 에서 L1 로 모은다(ADR-014). 세션 메타(상태·경고 등)는 L3(session-manager) 가
 * 소유하므로 이 모듈은 그 데이터를 `opts` 로 주입받는다(L1→L3 의존 금지 — GAP-010 참조).
 */
import { readdir } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { vaultPaths } from "../shared/paths.js";
import { ensureVaultLayout, sanitizeIsoForFilename } from "./vault-paths.js";
import { sanitizeEngineText } from "../shared/mask.js";
import { readEvents } from "./events.js";
import { isArchivedTurn } from "./retention.js";
import type { RetentionPolicy } from "./retention.js";
import type { AddeEvent, RecordCtx } from "./types.js";

/** 턴 노트 파일명 — `NNNN <turnStartTs>.md`(flat, ADR-017). 이벤트에서만 파생(결정론, FR-015·FR-016). */
export function turnNoteName(turn: number, turnStartIso: string): string {
  return `${String(turn).padStart(4, "0")} ${sanitizeIsoForFilename(turnStartIso)}.md`;
}

/** 기계 발췌 미리보기 — 본문 앞부분을 그대로 자른다(생성 문구 없음, FR-019·SC-019). */
export function preview(text: string, max = 200): string {
  return text.slice(0, max);
}

interface SessionMetaForNote {
  engine: string;
  engineRef: string | null;
  status: string;
  title: string | null;
  createdAt: string;
  lastActivityAt: string;
  warnings: string[];
}

interface ProjectSessionSummary {
  sid: string;
  status: string;
  title: string | null;
  lastActivityAt: string;
}

export interface ProjectOpts {
  turn?: number;
  retention?: RetentionPolicy;
  /** 세션 메타(상태 등) — session-manager 가 주입(L1→L3 의존 회피). */
  sessionMeta?: SessionMetaForNote;
  /** 지정 시 프로젝트 노트(세션 목록)도 함께 렌더한다. */
  projectSessions?: ProjectSessionSummary[];
}

interface TurnAccumulator {
  turn: number;
  turnStartIso: string;
  envelopeId: string;
  inputText: string;
  responseText: string;
  thinking: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ id: string; output: unknown; isError: boolean }>;
  permissions: Array<{
    reqId: string;
    tool: string;
    input: unknown;
    decision?: string;
    reason?: string;
  }>;
  usage: { input: number; output: number; costUsd: number } | null;
  errors: string[];
  ended: boolean;
  stopReason?: string;
  dupOf?: { turn: number; turnStartIso: string };
}

function newAccumulator(turn: number): TurnAccumulator {
  return {
    turn,
    turnStartIso: "",
    envelopeId: "",
    inputText: "",
    responseText: "",
    thinking: "",
    toolCalls: [],
    toolResults: [],
    permissions: [],
    usage: null,
    errors: [],
    ended: false,
  };
}

function foldEvent(acc: TurnAccumulator, e: AddeEvent): void {
  switch (e.t) {
    case "turn_start":
      acc.turnStartIso = e.ts;
      acc.envelopeId = e.envelopeId;
      acc.inputText = e.input.text;
      break;
    case "text":
      acc.responseText += e.delta;
      break;
    case "text_final":
      acc.responseText = typeof e.text === "string" ? e.text : `(blob: ${e.text.blob})`;
      break;
    case "thinking":
      acc.thinking += e.delta;
      break;
    case "tool_call":
      acc.toolCalls.push({ id: e.id, name: e.name, input: e.input });
      break;
    case "tool_result":
      acc.toolResults.push({ id: e.id, output: e.output, isError: e.isError ?? false });
      break;
    case "permission":
      acc.permissions.push({ reqId: e.reqId, tool: e.tool, input: e.input });
      break;
    case "permission_decision": {
      const p = acc.permissions.find((x) => x.reqId === e.reqId);
      if (p) {
        p.decision = e.decision;
        p.reason = e.reason;
      }
      break;
    }
    case "usage": {
      const prev = acc.usage ?? { input: 0, output: 0, costUsd: 0 };
      acc.usage = {
        input: prev.input + e.input,
        output: prev.output + e.output,
        costUsd: prev.costUsd + (e.costUsd ?? 0),
      };
      break;
    }
    case "error":
      acc.errors.push(e.message);
      break;
    case "turn_end":
      acc.ended = true;
      acc.stopReason = e.stopReason;
      if (e.dup) acc.dupOf = e.dup.of;
      break;
    default:
      break;
  }
}

/** 세션의 전 턴을 이벤트에서 재구성한다(턴 번호 오름차순). */
async function collectTurns(ctx: RecordCtx): Promise<Map<number, TurnAccumulator>> {
  const turns = new Map<number, TurnAccumulator>();
  for await (const e of readEvents(ctx)) {
    if (typeof (e as { turn?: unknown }).turn !== "number" || e.turn === 0) continue; // note 등 turn=0 경고성 이벤트 제외
    let acc = turns.get(e.turn);
    if (!acc) {
      acc = newAccumulator(e.turn);
      turns.set(e.turn, acc);
    }
    foldEvent(acc, e);
  }
  return turns;
}

function renderToolBlock(acc: TurnAccumulator): string {
  if (acc.toolCalls.length === 0) return "";
  const lines = acc.toolCalls.map((tc) => {
    const result = acc.toolResults.find((r) => r.id === tc.id);
    const status = result ? (result.isError ? "오류" : "완료") : "진행 중";
    return `- **${tc.name}**(${status}) — 입력: \`${jsonPreview(tc.input)}\`${
      result ? ` → 출력: \`${jsonPreview(result.output)}\`` : ""
    }`;
  });
  return `<details>\n<summary>도구 호출 ${acc.toolCalls.length}건</summary>\n\n${lines.join("\n")}\n\n</details>\n`;
}

function jsonPreview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return preview(s, 200);
}

function renderPermissionBlock(acc: TurnAccumulator): string {
  if (acc.permissions.length === 0) return "";
  const lines = acc.permissions.map(
    // 엔진 유래 tool 텍스트 살균 — 턴 노트 마크다운 구조 보호, 이미 살균된 값 재적용도 무해.
    (p) =>
      `- ${sanitizeEngineText(p.tool)} → **${p.decision ?? "대기"}**${p.reason ? ` (${p.reason})` : ""}`,
  );
  return `## 권한 요청·결정\n\n${lines.join("\n")}\n`;
}

/** 턴 노트 렌더(phase 별) — `isArchivedTurn` 이면 쓰지 않는다(이관분 재생성 금지, ADR-023b). */
async function renderTurnNote(
  ctx: RecordCtx,
  acc: TurnAccumulator,
  phase: "running" | "final",
  policy: RetentionPolicy | undefined,
): Promise<void> {
  if (policy && isArchivedTurn(policy, acc.turnStartIso)) return;
  await ensureVaultLayout(ctx.vaultRoot, ctx.proj, ctx.sid);
  const vp = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  const notePath = `${vp.turnsDir}/${turnNoteName(acc.turn, acc.turnStartIso)}`;
  const sessionLink = `[[sessions/${ctx.sid}/session]]`;

  const lines: string[] = [
    "---",
    `turn: ${acc.turn}`,
    `status: ${phase === "running" ? "처리 중" : acc.errors.length > 0 ? "오류" : "완료"}`,
    `startedAt: ${acc.turnStartIso}`,
    "---",
    "",
    `⬅ ${sessionLink}`,
    "",
    "## 입력",
    "",
  ];

  if (acc.dupOf) {
    lines.push(
      `본문이 이전 턴과 완전히 같습니다 → [[${turnNoteName(acc.dupOf.turn, acc.dupOf.turnStartIso).replace(/\.md$/, "")}]]`,
    );
  } else {
    lines.push(acc.inputText);
  }

  if (phase === "final") {
    lines.push("", "## 응답", "", acc.responseText || "(응답 없음)");
    const toolBlock = renderToolBlock(acc);
    if (toolBlock) lines.push("", toolBlock);
    const permBlock = renderPermissionBlock(acc);
    if (permBlock) lines.push("", permBlock);
    if (acc.usage) {
      lines.push(
        "",
        `## 사용량`,
        "",
        `입력 토큰 ${acc.usage.input} · 출력 토큰 ${acc.usage.output}${acc.usage.costUsd ? ` · $${acc.usage.costUsd.toFixed(4)}` : ""}`,
      );
    }
    if (acc.errors.length > 0) {
      lines.push("", "## 오류", "", ...acc.errors.map((m) => `- ${m}`));
    }
  }

  await atomicWrite(notePath, lines.join("\n") + "\n");
}

/** 세션 노트 렌더 — 턴 목록(기계 발췌 미리보기, 보관된 턴은 "보관됨" 표기)·경고·상태(FR-003·FR-019·FR-034·FR-040). */
async function renderSessionNote(
  ctx: RecordCtx,
  turns: Map<number, TurnAccumulator>,
  meta: SessionMetaForNote | undefined,
  policy: RetentionPolicy | undefined,
): Promise<void> {
  await ensureVaultLayout(ctx.vaultRoot, ctx.proj, ctx.sid);
  const vp = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);

  const sortedTurns = [...turns.values()].sort((a, b) => a.turn - b.turn);
  const turnLines = sortedTurns.map((acc) => {
    const archived = policy && isArchivedTurn(policy, acc.turnStartIso);
    const label = preview(acc.inputText || "(제목 없음)", 80);
    if (archived) return `- [${acc.turn}] ${acc.turnStartIso} — ${label} (보관됨)`;
    const link = `[[${turnNoteName(acc.turn, acc.turnStartIso).replace(/\.md$/, "")}]]`;
    return `- [${acc.turn}] ${acc.turnStartIso} — ${label} → ${link}`;
  });

  const lines: string[] = [
    "---",
    `sid: ${ctx.sid}`,
    `engine: ${meta?.engine ?? "unknown"}`,
    `engineRef: ${meta?.engineRef ?? "null"}`,
    `status: ${meta?.status ?? "unknown"}`,
    `created: ${meta?.createdAt ?? ""}`,
    `updated: ${meta?.lastActivityAt ?? ""}`,
    "---",
    "",
    `⬅ [[projects/${ctx.proj}/project]]`,
    "",
  ];

  if (meta && meta.warnings.length > 0) {
    // 세션 노트 경고 살균 — 경고 문자열이 향후 엔진 유래 텍스트를 포함하게 되어도
    // 세션 노트 구조가 깨지지 않도록 한다.
    lines.push("## 경고", "", ...meta.warnings.map((w) => `- ${sanitizeEngineText(w)}`), "");
  }

  lines.push("## 턴 목록", "", ...(turnLines.length > 0 ? turnLines : ["(턴 없음)"]));

  await atomicWrite(vp.sessionNote, lines.join("\n") + "\n");
}

/** 프로젝트 노트 렌더 — 세션 목록 + 새 세션 체크박스(FR-025·FR-031). */
export async function renderProjectNote(
  vaultRoot: string,
  proj: string,
  sessions: ProjectSessionSummary[],
): Promise<void> {
  await ensureVaultLayout(vaultRoot, proj);
  const vp = vaultPaths(vaultRoot, proj);
  const lines: string[] = ["---", `proj: ${proj}`, "---", "", "## 세션 목록", ""];
  if (sessions.length === 0) {
    lines.push("(세션 없음)");
  } else {
    for (const s of sessions) {
      lines.push(
        `- [[sessions/${s.sid}/session|${s.title ?? s.sid}]] — ${s.status} (최근 활동: ${s.lastActivityAt})`,
      );
    }
  }
  lines.push("", "- [ ] ➕ new session");
  await atomicWrite(vp.projectNote, lines.join("\n") + "\n");
}

/**
 * 턴 노트 투영 — `phase:"running"` 은 turn_start 선생성(입력 + "처리 중"), `"final"` 은 종료 후 갱신
 * (ADR-014). `policy` 를 입력으로 받아 이관된 턴은 재생성하지 않는다(ADR-023b).
 */
export async function projectTurn(
  ctx: RecordCtx,
  turn: number,
  phase: "running" | "final",
  policy?: RetentionPolicy,
): Promise<void> {
  const turns = await collectTurns(ctx);
  const acc = turns.get(turn);
  if (!acc) throw new Error(`record/projector: turn ${turn} 의 이벤트가 없습니다(sid=${ctx.sid}).`);
  await renderTurnNote(ctx, acc, phase, policy);
}

/**
 * 세션 노트(+옵션으로 프로젝트 노트) 투영 — `opts.turn` 이 지정되면 그 턴 노트도 함께 갱신(final 취급).
 */
export async function project(ctx: RecordCtx, opts?: ProjectOpts): Promise<void> {
  const turns = await collectTurns(ctx);
  if (opts?.turn !== undefined) {
    const acc = turns.get(opts.turn);
    if (acc) await renderTurnNote(ctx, acc, "final", opts.retention);
  }
  await renderSessionNote(ctx, turns, opts?.sessionMeta, opts?.retention);
  if (opts?.projectSessions) {
    await renderProjectNote(ctx.vaultRoot, ctx.proj, opts.projectSessions);
  }
}

/** 세션의 turns/ 디렉터리 실제 파일 목록(재생성 비교·정리 용도). */
export async function listTurnNoteFiles(
  vaultRoot: string,
  proj: string,
  sid: string,
): Promise<string[]> {
  const vp = vaultPaths(vaultRoot, proj, sid);
  try {
    return (await readdir(vp.turnsDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}
