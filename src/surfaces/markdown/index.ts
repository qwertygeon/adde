/**
 * markdown Surface(L4) — 세션별 입력 노트 3존·승인 노트·프로젝트 노트 새 세션 체크박스(FR-024·
 * FR-026·FR-036·FR-038·FR-039·FR-040). 출력 소유는 L1 투영기에 있다(ADR-014) — 본 모듈은 인바운드
 * 수신·마커 2단계 전이·승인 표면화만 담당한다. fs.watch + 폴링 백스톱 하이브리드(단순화 버전).
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import { vaultPaths } from "../../shared/paths.js";
import { ensureVaultLayout, isConflictFile } from "../../record/vault-paths.js";
import { atomicWrite } from "../../shared/fs-atomic.js";
import { loadResumeIndex } from "../../record/events.js";
import type { Envelope } from "../../shared/envelope.js";
import {
  parseInbox,
  healLayout,
  ensureBlankSend,
  sendingLine,
  sentLine,
  emptyLine,
  renderPalette,
  planRecordsCap,
  planRecordsClear,
} from "./inbox.js";
import { renderApprovalBlock, parseApprovals, finalizeApprovalDeny } from "./approvals.js";
import { handleProjectNoteTriggers } from "./project-note.js";
import type {
  Binding,
  OutboundMessage,
  PermRequest as SurfacePermRequest,
  Surface,
  SurfaceContext,
  SurfaceDescriptor,
} from "../types.js";
import type { EngineCaps } from "../../engines/types.js";

const POLL_INTERVAL_MS = 2_000;

function formatStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createMarkdownSurface(ctx: SurfaceContext): Surface {
  const sm = ctx.sessionManager;
  const router = ctx.router;
  if (!sm || !router) {
    throw new Error("markdown surface: sessionManager·router 조립이 필요합니다.");
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let decisionCb: ((reqId: string, decision: "allow" | "deny") => void) | undefined;
  let stopped = false;

  function bindingFor(sid: string): Binding {
    return { surface: "markdown", address: `sessions/${sid}/inbox.md`, sid };
  }

  /** 코어 엔진 무지(A-P007) — SessionManager.capsOf 를 통해서만 caps 를 얻는다(엔진 id 비교 없음). */
  function capsFor(sid: string): EngineCaps {
    return (
      sm!.capsOf(sid) ?? {
        resume: "none",
        permission: "none",
        streaming: false,
        usage: false,
        compact: "none",
        attachments: [],
      }
    );
  }

  async function ensureInboxSkeleton(sid: string): Promise<void> {
    await ensureVaultLayout(ctx.vaultRoot, ctx.proj, sid);
    const vp = vaultPaths(ctx.vaultRoot, ctx.proj, sid);
    let content: string;
    try {
      content = await readFile(vp.inboxNote, "utf8");
    } catch {
      content = "";
    }
    const caps = capsFor(sid);
    const lines = content.length > 0 ? content.split("\n") : [];
    // 미소비 액션(체크된 체크박스)이 있으면 치유 쓰기를 건너뛴다 — `healLayout` 은 노트를 재구성하며
    // send 줄을 **무조건 미체크**(`blankSendLine()`)로 되돌리므로, 액션 소비(processSession) 앞에서
    // 치유하면 사용자가 방금 체크한 전송이 읽히기 전에 지워진다. 치유는 액션이 없는 idle 상태에서만
    // 하고, 액션 소비 후의 정규화는 processSession 이 담당한다.
    if (content.length > 0 && parseInbox(content).actions.length > 0) return;
    const healed = healLayout(lines, { paletteEnabled: true, caps });
    ensureBlankSend(healed.lines);
    if (healed.changed || content.length === 0) {
      await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
    }
  }

  /**
   * poll 대상 세션 — **세션 레코드의 markdown 바인딩에서 파생**한다. vault 디렉터리 목록을 읽던 이전
   * 구현은 씨딩 대상 집합이 씨딩 결과(`ensureInboxSkeleton` → `ensureVaultLayout`)에 의존해, 신규 세션이
   * 영원히 입력 노트를 받지 못하는 교착이었다. 바인딩 파생은 부수적으로 (a) 레코드가 사라진 세션의 잔존
   * 디렉터리를 재씨딩하지 않고 (b) `clear` 로 바인딩을 넘긴 archived 세션을 자동 제외하며 (c) 동기화 폴더의
   * 디렉터리 목록 지연·충돌 파일 영향을 받지 않는다.
   */
  function knownSids(): string[] {
    return sm!
      .list()
      .filter((rec) => rec.bindings.some((b) => b.surface === "markdown"))
      .map((rec) => rec.sid);
  }

  async function processSession(sid: string): Promise<void> {
    const rec = sm!.get(sid);
    if (!rec) return;
    const vp = vaultPaths(ctx.vaultRoot, ctx.proj, sid);
    let content: string;
    try {
      content = await readFile(vp.inboxNote, "utf8");
    } catch {
      return;
    }
    const parsed = parseInbox(content);
    const lines = [...parsed.lines];
    let mutated = false;
    const recordsInsertAt = parsed.recordsIndex !== null ? parsed.recordsIndex + 1 : lines.length;

    for (const action of parsed.actions) {
      if (action.kind === "fresh") {
        const envelopeId = randomUUID();
        const stamp = formatStamp(new Date());
        const env: Envelope = {
          v: 1,
          id: envelopeId,
          lane: sid,
          source: "markdown",
          backend: "acp",
          engine: rec.engine,
          project: ctx.proj,
          ts: new Date().toISOString(),
          text: action.text,
        };
        try {
          await router!.dispatch(bindingFor(sid), env);
        } catch (err) {
          console.error(
            `markdown surface: dispatch 실패(sid=${sid}): ${err instanceof Error ? err.message : String(err)}`,
          );
          continue; // 본문 유지·마커 미기록(SC-049 Error) — 재시도 가능.
        }
        lines[action.lineIndex] = sendingLine(envelopeId, stamp);
        mutated = true;
      } else if (action.kind === "empty") {
        lines[action.lineIndex] = emptyLine();
        mutated = true;
      } else if (action.kind === "resume") {
        // 크래시 재개 backstop — 이벤트 기록에 turn_end 가 있으면 마커를 완결 링크로 전이.
        const index = await loadResumeIndex({
          base: ctx.base,
          vaultRoot: ctx.vaultRoot,
          proj: ctx.proj,
          sid,
        });
        const entry = action.id ? index.get(action.id) : undefined;
        if (entry?.ended) {
          lines[action.lineIndex] = sentLine(entry.turn, new Date().toISOString());
          mutated = true;
        }
        // 미완이면 그대로 둔다(재-enqueue 금지, ADR-027 — TurnRunner 이어받기로만 완결).
      } else if (action.kind === "archive") {
        const start = parsed.recordsIndex !== null ? parsed.recordsIndex + 1 : lines.length;
        const cleared = planRecordsClear(lines, start);
        if (cleared.changed) {
          lines.length = 0;
          lines.push(...cleared.lines);
          mutated = true;
        }
      } else if (action.kind === "control") {
        if (action.controlKind === "clear") {
          try {
            const { next } = await sm!.clear(sid);
            const newVp = vaultPaths(ctx.vaultRoot, ctx.proj, next);
            await ensureVaultLayout(ctx.vaultRoot, ctx.proj, next);
            await rename(vp.inboxNote, newVp.inboxNote).catch(() => {});
            await sm!.registerBinding(next, bindingFor(next));
          } catch (err) {
            console.error(
              `markdown surface: clear 실패(sid=${sid}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (action.controlKind === "compact") {
          try {
            const engineSession = await sm!.admit(sid);
            await engineSession.compact?.();
          } catch (err) {
            console.error(
              `markdown surface: compact 실패(sid=${sid}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (action.controlKind === "resume") {
          try {
            await sm!.admit(sid);
          } catch (err) {
            console.error(
              `markdown surface: resume 실패(sid=${sid}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        mutated = true; // 팔레트 항목은 항상 미체크 복원 대상(healLayout 이 처리).
      }
    }

    const cap = ctx.conf?.["markdown.records_cap"] ?? 0; // 미지정 시 끔(FR-039·NFR-009 기본).
    if (cap > 0) {
      const capped = planRecordsCap(lines, recordsInsertAt, cap, formatStamp(new Date()));
      if (capped.changed) {
        lines.length = 0;
        lines.push(...capped.lines);
        mutated = true;
      }
    }

    const healed = healLayout(lines, { paletteEnabled: true, caps: capsFor(sid) });
    ensureBlankSend(healed.lines);
    if (mutated || healed.changed) {
      await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
    }
  }

  async function processApprovals(sid: string): Promise<void> {
    const vp = vaultPaths(ctx.vaultRoot, ctx.proj, sid);
    let files: string[];
    try {
      files = await readdir(vp.approvalsDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".md") || isConflictFile(f)) continue;
      const filePath = `${vp.approvalsDir}/${f}`;
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseApprovals(content);
      if (parsed.changed) await atomicWrite(filePath, parsed.newContent);
      for (const d of parsed.decisions) decisionCb?.(d.reqId, d.decision);
    }
  }

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    try {
      // CLI 프로세스가 만든 신규 세션 레코드를 흡수한다 — 데몬은 부팅 시 로드한 레코드만 보므로,
      // 이 호출 없이는 기동 중 생성된 세션이 재기동 전까지 인지되지 않는다(additive-only).
      await sm!.refresh();
      await handleProjectNoteTriggers(ctx.vaultRoot, ctx.proj, sm!);
      for (const sid of knownSids()) {
        await ensureInboxSkeleton(sid);
        await processSession(sid);
        await processApprovals(sid);
      }
    } catch (err) {
      console.error(
        `markdown surface: poll 오류: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      await pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
      pollTimer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
    },

    async deliver(binding: Binding, _msg: OutboundMessage): Promise<void> {
      void binding;
      // 마커 2단계 전이는 onTurnAssigned 가 소유 — deliver 는 계약 충족을 위한 no-op(향후 확장 지점).
    },

    async onTurnAssigned(binding: Binding, m): Promise<void> {
      const vp = vaultPaths(ctx.vaultRoot, ctx.proj, binding.sid);
      let content: string;
      try {
        content = await readFile(vp.inboxNote, "utf8");
      } catch {
        return;
      }
      const lines = content.split("\n");
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(`sending ${m.envelopeId}`)) {
          lines[i] = sentLine(m.turnRef.turn, m.turnRef.turnStartIso);
          changed = true;
          break;
        }
      }
      if (changed) await atomicWrite(vp.inboxNote, lines.join("\n") + "\n");
    },

    async askPermission(binding: Binding, req: SurfacePermRequest): Promise<void> {
      const vp = vaultPaths(ctx.vaultRoot, ctx.proj, binding.sid);
      const permReq = {
        v: 1 as const,
        id: req.reqId,
        sid: binding.sid,
        channel: "markdown",
        tool: req.tool,
        detail: typeof req.input === "string" ? req.input : JSON.stringify(req.input),
        cwd: ctx.proj,
        ts: new Date().toISOString(),
      };
      await atomicWrite(`${vp.approvalsDir}/${req.reqId}.md`, renderApprovalBlock(permReq));
    },

    onDecision(cb: (reqId: string, decision: "allow" | "deny") => void): void {
      decisionCb = cb;
    },

    async onDecisionRecorded(binding: Binding, reqId: string): Promise<void> {
      const vp = vaultPaths(ctx.vaultRoot, ctx.proj, binding.sid);
      await unlink(`${vp.approvalsDir}/${reqId}.md`).catch(() => {});
    },

    renderPalette(caps: EngineCaps): string[] {
      return renderPalette(caps, true);
    },
  };
}

export const markdownSurfaceDescriptor: SurfaceDescriptor = {
  id: "markdown",
  status: "implemented",
  factory: createMarkdownSurface,
};

/** 강제 종단(타임아웃 등) 시 승인 파일을 deny 로 재작성 — gate 배선부가 필요 시 호출(보조 export). */
export async function forceFinalizeApproval(
  vaultRoot: string,
  proj: string,
  sid: string,
  reqId: string,
  reason: string,
): Promise<void> {
  const vp = vaultPaths(vaultRoot, proj, sid);
  const filePath = `${vp.approvalsDir}/${reqId}.md`;
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  const result = finalizeApprovalDeny(content, reqId, reason);
  if (result.changed) await atomicWrite(filePath, result.newContent);
}
