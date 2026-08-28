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
import { errMsg } from "../../shared/errors.js";
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

  /**
   * 상태 존에 실을 세션 경고 — 노트는 레코드의 파생물이라 여기서만 읽는다(별도 상태 없음).
   * 생성 시점 안내성 경고(`engine-no-resume`)는 제외한다: 미해소 상태가 아니라 그 엔진의 항구적
   * 성질이고 `session new` 가 이미 알렸으므로, 노트에 상주하면 해소할 수 없는 경고가 된다.
   * `status` 는 레코드 경고 전체를 세므로 개수가 다를 수 있다(표는 레코드 뷰, 노트는 미해소 실패 뷰).
   */
  const INFORMATIONAL_WARNINGS = new Set(["engine-no-resume"]);
  function warningsFor(sid: string): readonly string[] {
    return (sm!.get(sid)?.warnings ?? []).filter((w) => !INFORMATIONAL_WARNINGS.has(w));
  }

  /**
   * 세션 경고 등록·해소 — 레코드는 SessionManager 가 단일 writer 이므로 그 경로로만 올린다(L4→L3).
   * 경고 영속 자체가 실패하면 표면화 수단이 남지 않으므로 로그로 남긴다(더 상위 채널이 없다).
   */
  async function noteFailure(sid: string, kind: string, reason: string): Promise<void> {
    await sm!.noteFailure(sid, kind, reason).catch((err: unknown) => {
      console.error(`markdown surface: 경고 기록 실패(sid=${sid}, kind=${kind}): ${errMsg(err)}`);
    });
  }

  async function clearFailure(sid: string, kind: string): Promise<void> {
    await sm!.clearFailure(sid, kind).catch((err: unknown) => {
      console.error(`markdown surface: 경고 해소 실패(sid=${sid}, kind=${kind}): ${errMsg(err)}`);
    });
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
    const healed = healLayout(lines, { paletteEnabled: true, caps, warnings: warningsFor(sid) });
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
          // 마커를 기록하지 않고 넘기면 같은 tick 말미의 치유가 send 줄을 미체크로 되돌리므로,
          // 사용자에게는 "체크가 저절로 풀린" 것으로만 보인다 — 적재 실패를 경고로 올린다.
          console.error(`markdown surface: dispatch 실패(sid=${sid}): ${errMsg(err)}`);
          await noteFailure(sid, "enqueue-failed", `지시 적재 실패: ${errMsg(err)}`);
          continue; // 본문 유지·마커 미기록(SC-049 Error) — 재시도 가능.
        }
        await clearFailure(sid, "enqueue-failed");
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
        // 팔레트 항목은 성공·실패 모두 미체크로 복원되므로(healLayout) 노트 결과만으로는 구분되지
        // 않는다 — 실패를 경고로 올려 "눌렀는데 아무 일도 없다" 를 없앤다.
        if (action.controlKind === "clear") {
          try {
            const { next } = await sm!.clear(sid);
            const newVp = vaultPaths(ctx.vaultRoot, ctx.proj, next);
            await ensureVaultLayout(ctx.vaultRoot, ctx.proj, next);
            // 세션 교체는 이미 성공했으므로 노트 이름 변경 실패는 **부분 실패**다(새 sid 와 노트가
            // 어긋난 상태) — 새 세션 쪽에 경고를 남긴다. 사용자가 보게 되는 노트가 그쪽이다.
            try {
              await rename(vp.inboxNote, newVp.inboxNote);
            } catch (renameErr) {
              console.error(
                `markdown surface: clear 노트 이동 실패(sid=${sid}): ${errMsg(renameErr)}`,
              );
              await noteFailure(
                next,
                "palette-failed",
                `세션은 교체됐으나 이전 입력 노트 이동 실패: ${errMsg(renameErr)}`,
              );
            }
            await sm!.registerBinding(next, bindingFor(next));
            await clearFailure(sid, "palette-failed");
          } catch (err) {
            console.error(`markdown surface: clear 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `세션 교체 실패: ${errMsg(err)}`);
          }
        } else if (action.controlKind === "compact") {
          try {
            const engineSession = await sm!.admit(sid);
            await engineSession.compact?.();
            await clearFailure(sid, "palette-failed");
          } catch (err) {
            console.error(`markdown surface: compact 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `대화 압축 실패: ${errMsg(err)}`);
          }
        } else if (action.controlKind === "resume") {
          try {
            await sm!.admit(sid);
            await clearFailure(sid, "palette-failed");
          } catch (err) {
            console.error(`markdown surface: resume 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `엔진 재개 실패: ${errMsg(err)}`);
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

    const healed = healLayout(lines, {
      paletteEnabled: true,
      caps: capsFor(sid),
      warnings: warningsFor(sid),
    });
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

  /**
   * 한 tick — 단계·세션 단위로 격리한다. 이전 구현은 폴 전체를 하나의 try 로 감싸 앞 세션의 노트
   * 쓰기 예외가 뒤 세션의 전송 적재·승인 소비를 건너뛰게 했다. 실패가 지속적(권한·마운트)이면 뒤
   * 세션은 영구히 처리되지 않고, 원인 세션과 피해 세션이 달라 추적이 사실상 불가능하다.
   */
  async function pollOnce(): Promise<void> {
    if (stopped) return;
    try {
      // CLI 프로세스가 만든 신규 세션 레코드를 흡수한다 — 데몬은 부팅 시 로드한 레코드만 보므로,
      // 이 호출 없이는 기동 중 생성된 세션이 재기동 전까지 인지되지 않는다(additive-only).
      await sm!.refresh();
    } catch (err) {
      console.error(`markdown surface: 세션 레코드 흡수 실패: ${errMsg(err)}`);
    }
    try {
      await handleProjectNoteTriggers(ctx.vaultRoot, ctx.proj, sm!);
    } catch (err) {
      console.error(`markdown surface: 프로젝트 노트 처리 실패: ${errMsg(err)}`);
    }
    for (const sid of knownSids()) {
      if (stopped) return;
      try {
        await ensureInboxSkeleton(sid);
        await processSession(sid);
        await processApprovals(sid);
        await clearFailure(sid, "note-failed");
      } catch (err) {
        console.error(`markdown surface: 세션 처리 실패(sid=${sid}): ${errMsg(err)}`);
        await noteFailure(sid, "note-failed", `입력 노트 처리 실패: ${errMsg(err)}`);
      }
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
