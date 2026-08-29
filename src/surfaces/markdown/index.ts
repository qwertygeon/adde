/**
 * markdown Surface(L4) — 세션별 입력 노트 3존·승인 노트·프로젝트 노트 새 세션 체크박스(FR-024·
 * FR-026·FR-036·FR-038·FR-039·FR-040). 출력 소유는 L1 투영기에 있다 — 본 모듈은 인바운드
 * 수신·마커 2단계 전이·승인 표면화만 담당한다. fs.watch + 폴링 백스톱 하이브리드(단순화 버전).
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { isSafeSegment, vaultPaths } from "../../shared/paths.js";
import { ensureVaultLayout, isConflictFile } from "../../record/vault-paths.js";
import { atomicWrite } from "../../shared/fs-atomic.js";
import { errMsg, errCode } from "../../shared/errors.js";
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
  renderStoppedNote,
  planRecordsCap,
  planRecordsClear,
} from "./inbox.js";
import { parseNoticeZone, planNoticeSync } from "./notices.js";
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
import type { StopNoteInfo } from "../../core/session-manager.js";
import type { NoticeEntry } from "../../core/session-store.js";

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

  /**
   * 안내 존에 미소비 상호작용(체크·삭제·선택·취소)이 있는가 — `parseInbox` 의 액션 목록은 안내
   * 체크박스·prompt 옵션 줄을 포함하지 않으므로(별도 경로, `parseNoticeZone`) 이 판정이 없으면
   * `ensureInboxSkeleton` 이 매 tick 무조건 재렌더해 `processSession` 이 관측하기 전에 사용자의
   * 체크·삭제를 되돌린다(GAP-008).
   */
  function hasUnconsumedNoticeInteraction(lines: readonly string[], sid: string): boolean {
    const notices = sm!.takeNotices(sid);
    if (notices.length === 0) return false;
    const observed = parseNoticeZone(lines);
    const plan = planNoticeSync(notices, observed, true);
    // `notYetReflected` 도 미소비 상호작용이다 — 빠뜨리면 이 함수가 "소비된 것 없음" 으로 오판해
    // `ensureInboxSkeleton` 이 healLayout 으로 노트를 즉시 복구한다. 그러면 `processSession` 이
    // 이 tick 에 삭제를 관측하기도 전에(그 함수는 이 함수 **다음** 에 실행된다) 항목이 이미
    // 되살아나 있어 "관측된 적 없음" 으로 계속 재관측돼 영구 원복된다(rework4 프로브로 발견 —
    // SC-040 완화가 아예 트리거되지 않는 회귀).
    return (
      plan.consumed.length > 0 ||
      Boolean(plan.chosen) ||
      Boolean(plan.cancelled) ||
      plan.notYetReflected.length > 0
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
    // 하고, 액션 소비 후의 정규화는 processSession 이 담당한다. 안내 존 체크·삭제·선택·취소도 같은
    // 이유로 미소비 상호작용으로 취급한다(parseInbox 의 액션 목록 밖이라 별도 판정이 필요하다).
    if (
      content.length > 0 &&
      (parseInbox(content).actions.length > 0 || hasUnconsumedNoticeInteraction(lines, sid))
    ) {
      return;
    }
    const healed = healLayout(lines, {
      paletteEnabled: true,
      caps,
      warnings: warningsFor(sid),
      notices: sm!.takeNotices(sid),
    });
    ensureBlankSend(healed.lines);
    if (healed.changed || content.length === 0) {
      await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
    }
  }

  /**
   * poll 대상 세션 — **세션 레코드의 markdown 바인딩에서 파생**한다. vault 디렉터리 목록을 읽던 이전
   * 구현은 씨딩 대상 집합이 씨딩 결과(`ensureInboxSkeleton` → `ensureVaultLayout`)에 의존해, 신규 세션이
   * 영원히 입력 노트를 받지 못하는 교착이었다. 바인딩 파생은 부수적으로 (a) 레코드가 사라진 세션의 잔존
   * 디렉터리를 재씨딩하지 않고 (b) `clear` 로 바인딩을 넘긴 세션을 상태 필터로 자동 제외하며 (c) 동기화
   * 폴더의 디렉터리 목록 지연·충돌 파일 영향을 받지 않는다.
   *
   * **중지·떨어짐 제외** — 감시 종료가 그 상태의 정의이므로 입력 노트·승인 디렉터리
   * 파일 접근이 이 폴 경로에서는 tick 당 0회다. 노트 교체 부분 실패(`stopNotePending`)의 재시도는
   * SessionManager 의 control 드레인 tick(2초, `writeStoppedNoteOnce`)이 이 폴과 독립적으로
   * 담당한다 — 여기서 재포함시키면 `ensureInboxSkeleton`/`processSession` 이 정상 스켈레톤을
   * 되만들어 방금 확정한 중지 배너를 덮어쓴다(§안전망 "노트 교체 실패 후의 표면화").
   */
  function knownSids(): string[] {
    return sm!
      .list()
      .filter((rec) => rec.bindings.some((b) => b.surface === "markdown"))
      .filter((rec) => rec.status !== "stopped" && rec.status !== "detached")
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
    // 이 tick 의 액션 처리 시작 **전** 안내 스냅샷 — 아래 안내 존 동기화가 이걸 써야 한다. 액션
    // 루프가 이 함수 안에서 새 안내를 push 할 수 있는데(예: stop-scheduled), 루프 이후 시점의
    // `sm!.takeNotices()` 를 쓰면 방금 생긴 안내가 "관측된 노트(이 tick 시작 시점 스냅샷)에는
    // 당연히 없음" 으로 걸려 `notYetReflected` 오탐(사용자가 지운 적 없는데 "아직 반영 안 됨"
    // 안내가 스팸으로 뜬다)이 난다 — 시점을 맞춰야 한다(rework3 프로브 실측으로 발견).
    const noticesBeforeActions = sm!.takeNotices(sid);
    const parsed = parseInbox(content);
    const lines = [...parsed.lines];
    let mutated = false;
    // dispatch(큐 적재)는 되돌릴 수 없는 부수효과다 — 이 tick 의 최종 쓰기가 "파일이 그 사이
    // 바뀌었으면 스킵" 가드(GAP-008 대응)에 걸리면 마커(sendingLine)가 유실돼 다음 tick 이 같은
    // 체크된 send 를 다시 "fresh" 로 읽어 재적재한다(중복 지시, rework2 신규 발견). 이 tick 에
    // 실제 dispatch 가 있었으면 그 가드를 건너뛰고 무조건 커밋한다.
    let dispatchedThisTick = false;
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
        dispatchedThisTick = true;
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
          // FR-011 — clear 는 이제 "현재 세션 중지 + 새 세션 생성" 이다. 이전 세션의 노트는
          // `sm.clear()` 내부의 중지 노트 훅(writeStoppedNote)이 **그 자리에서** 배너로 교체하므로
          // 여기서 파일을 옮기지 않는다 — 새 세션은 자기 소유의 새 노트를 받는다(두 노트 공존,
          // SC-024). 새 노트 자체는 다음 tick 의 `ensureInboxSkeleton` 이 바인딩 등록을 보고 만든다.
          // `clear()` 자체와 그 뒤의 `registerBinding()` 을 **별도 try/catch** 로 나눈다 — 세션
          // 교체(A 중지 + B 생성)는 이미 성공했는데 단일 try/catch 로 묶으면 그 뒤의 바인딩 등록
          // 실패가 전체를 실패로 오분류해 성공한 부분(B 자체)까지 감춘다(GAP-009). 부분 실패는
          // 이미 존재하는 B 쪽에 경고로 남긴다(design SC-024 Error — "새 세션 쪽 경고").
          let next: string | undefined;
          try {
            next = (await sm!.clear(sid)).next;
            await clearFailure(sid, "palette-failed");
          } catch (err) {
            console.error(`markdown surface: clear 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `세션 교체 실패: ${errMsg(err)}`);
          }
          if (next !== undefined) {
            try {
              await sm!.registerBinding(next, bindingFor(next));
            } catch (err) {
              console.error(
                `markdown surface: clear 후 바인딩 등록 실패(sid=${sid}→${next}): ${errMsg(err)}`,
              );
              await noteFailure(
                next,
                "palette-failed",
                `승계된 새 세션의 노트 바인딩 등록 실패: ${errMsg(err)}`,
              );
            }
          }
        } else if (action.controlKind === "compact") {
          try {
            const engineSession = await sm!.admit(sid);
            await engineSession.compact?.();
            await clearFailure(sid, "palette-failed");
            await sm!.pushNotice(sid, { kind: "compact-done", text: "대화를 압축했습니다." });
          } catch (err) {
            console.error(`markdown surface: compact 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `대화 압축 실패: ${errMsg(err)}`);
          }
        } else if (action.controlKind === "stop") {
          // FR-010 — 세션 중지만 수행한다(새 세션 생성 없음). 결과 안내(예약·완료·이미 중지/예약됨)는
          // SessionManager.stop 내부(applyStop)가 대상 세션에 직접 남긴다.
          try {
            const r = await sm!.stop(sid, { reason: "palette", source: "palette" });
            if (r.result === "stopped" || r.result === "scheduled") {
              await clearFailure(sid, "palette-failed");
            } else {
              // "already"(이미 중지·예약됨)도 CLI·control 과 동일하게 실패로 표면화한다 — 무동작
              // 성공 처리 금지(design.md §3 안내 지점 18과 동일 규약, rework2 신규 발견).
              await noteFailure(sid, "palette-failed", `중지 실패: ${r.reason ?? r.result}`);
            }
          } catch (err) {
            console.error(`markdown surface: stop 실패(sid=${sid}): ${errMsg(err)}`);
            await noteFailure(sid, "palette-failed", `중지 실패: ${errMsg(err)}`);
          }
        } else if (action.controlKind === "resume") {
          // FR-012 — 재정의된 resume: 중지·떨어짐 세션의 재개(자기 세션 엔진 재개 아님, FR-024).
          if (action.controlArg) {
            // 인자 형태 — 목록 단계 생략, 정확 일치로 즉시 재개.
            if (!isSafeSegment(action.controlArg)) {
              await sm!.pushNotice(sid, {
                kind: "resume-badformat",
                text: `형식이 올바르지 않은 식별자입니다: ${action.controlArg}`,
              });
            } else if (!sm!.get(action.controlArg)) {
              await sm!.pushNotice(sid, {
                kind: "resume-unknown",
                text: `대상 세션을 찾을 수 없습니다: ${action.controlArg}`,
              });
            } else {
              const r = await sm!.resume(action.controlArg);
              if (r.result === "resumed") {
                await sm!.pushNotice(sid, {
                  kind: "resume-done-requester",
                  text: `세션(${action.controlArg})을 재개했습니다.`,
                });
              } else if (r.result === "mismatch") {
                await sm!.pushNotice(sid, {
                  kind: "state-mismatch",
                  text: `이미 활성 계열 상태라 재개할 수 없습니다: ${action.controlArg}`,
                  replace: true,
                });
              } else {
                await sm!.pushNotice(sid, {
                  kind: "resume-failed-requester",
                  text: `재개 실패(${action.controlArg}): ${r.reason ?? "알 수 없는 오류"}`,
                });
              }
            }
          } else {
            // 인자 없음 — 2단계 선택: 대상 목록을 안내 존에 prompt 로 렌더.
            await sm!.pushResumeListNotice(sid);
          }
        }
        mutated = true; // 팔레트 항목은 항상 미체크 복원 대상(healLayout 이 처리).
      }

      // 노트에 나타난 순서대로 액션을 처리하므로(위 for), 중지·떨어짐 액션이 전송 액션보다
      // **먼저** 오는 편집에서는 전이 이후에도 루프가 계속 돌아 이미 중지된 세션에 dispatch 가
      // 일어날 수 있다(반대 순서는 큐 probe 가 예약으로 돌려 이미 안전 — 프로브로 확인됨). 전이를
      // 감지하면 남은 액션을 처리하지 않고 즉시 중단한다 — 액션 루프 이후의 조기 반환(아래)만으로는
      // 이 순서 의존 dispatch 자체를 막지 못한다(rework4, main 지시).
      const curStatus = sm!.get(sid)?.status;
      if (curStatus === "stopped" || curStatus === "detached") break;
    }

    // 배너 writer 는 SessionManager 훅(`onStopApplied`, applyStop·markDetached·clear) 단일
    // 소유다(rework2 — 3-writer 중복이 승계 안내 소실·중복 쓰기·과도 상태 노출을 만들었다). 액션
    // 처리 중 이 세션이 중지·떨어짐으로 전이됐으면(팔레트 stop·compact 중 admit() 이 내부적으로
    // markDetached 를 호출하는 재개 실패 등, design.md 원 코멘트 "재개 실패로 인한 detached 전이도
    // 이 함수를 재사용한다" 참조) 아래 공유 렌더 경로(안내 동기화+healLayout+write)를 **전혀 타지
    // 않고** 그대로 반환한다 — 배너를 다시 쓰지 않는다(writer 단일화 유지, rework1 의 L4 가드처럼
    // 재작성하지 않는다). `dispatchedThisTick` 가 true 인 tick 에서 이 가드가 없으면 아래 최종
    // 쓰기가 재확인 없이 무조건 커밋돼, 훅이 이미 쓴 배너를 정상 스켈레톤으로 덮어쓴다 — "재확인
    // 가드에 우연히 의존" 하던 보호를 명시적 조기 반환으로 대체한다(rework3, main 감사 실측).
    //
    // 중지 액션이 전송 액션보다 **먼저** 오는 편집에서 처리되지 못한 나머지 전송 지시는(위 루프의
    // 중단으로 dispatch 되지 않는다) 새 필드·예약 재해석 없이 그대로 노트 초안(draft)으로 남는다
    // — `renderStoppedNote`(inbox.ts)가 compose 이후 초안을 그대로 보존하고 send 체크박스만
    // 제거하는 구조라, 사용자가 재개 후 다시 체크하면 된다(main 결정 — StopNoteInfo 확장·예약
    // 의미 재정의 둘 다 하지 않는다, rework4). 이미 dispatch 된(전송이 먼저 온) 지시는 큐 probe→
    // 예약 경로가 이미 올바르게 처리한다(prove 로 확인, rework3).
    const recAfterActions = sm!.get(sid);
    if (recAfterActions?.status === "stopped" || recAfterActions?.status === "detached") {
      return;
    }

    // 안내 존 동기화 — 레코드가 SoT, 노트 관측(체크·삭제)을 대조해 소비·선택·취소를 반영한다.
    // 노트는 이미 읽었으므로(위 content) `noteExists` 는 항상 true — 이 tick 시점 노트가 존재한다.
    // 대조는 `noticesBeforeActions`(이 tick 액션 루프 시작 전 스냅샷) 대 `parsed.lines`(같은
    // 시점의 노트) 로 한다 — 시점을 맞추지 않고 액션 루프가 방금 추가한 안내(예: stop-scheduled)
    // 까지 포함해 비교하면, 그 안내는 "관측된 적 없음" 으로 오분류돼 `notYetReflected` 스팸이
    // 난다(rework3 프로브 실측으로 발견). 그 신규 안내는 병합만 하고 동기화 대상에서 제외한다.
    if (noticesBeforeActions.length > 0) {
      const observed = parseNoticeZone(parsed.lines);
      const plan = planNoticeSync(noticesBeforeActions, observed, true);
      const noticesChanged =
        plan.consumed.length > 0 ||
        Boolean(plan.chosen) ||
        Boolean(plan.cancelled) ||
        plan.notYetReflected.length > 0 ||
        JSON.stringify(plan.keep) !== JSON.stringify(noticesBeforeActions);
      if (noticesChanged) {
        const beforeIds = new Set(noticesBeforeActions.map((n) => n.id));
        const addedDuringActions = sm!.takeNotices(sid).filter((n) => !beforeIds.has(n.id));
        await sm!.applyNoticeSync(sid, { ...plan, keep: [...plan.keep, ...addedDuringActions] });
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
      notices: sm!.takeNotices(sid),
    });
    ensureBlankSend(healed.lines);
    if (mutated || healed.changed) {
      if (dispatchedThisTick) {
        // dispatch 부수효과가 이미 발생했다 — 재확인 스킵은 sendingLine 마커 유실 → 다음 tick
        // 재적재(중복 지시)로 이어지므로 여기서는 무조건 커밋한다.
        await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
      } else {
        // 쓰기 직전 재확인 — 이 함수 시작 시점의 `content` 스냅샷을 기준으로 병합한 결과라, 그 사이
        // 외부(사용자의 안내 존 체크·삭제 등)가 파일을 동시에 고치면 스냅샷 기반 결과로 덮어써 그
        // 변경이 손실된다(GAP-008 연장 — 5ms 간격 관측에서 재현). 그 사이 변화가 없을 때만 쓰고,
        // 있으면 다음 tick 이 최신 파일을 다시 읽어 반영한다(재시도는 안전 — 매 tick 디스크가 SoT).
        const current = await readFile(vp.inboxNote, "utf8").catch(() => null);
        if (current === content) {
          await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
        }
      }
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

/**
 * 미소비 전송 체크박스 — `SessionManager.stop` 의 `pendingSurfaceWork` probe 대상.
 * 독립 함수(세션 매니저 클로저 불필요)라 조립부가 얇게 주입할 수 있다.
 */
export async function hasUnconsumedSend(a: {
  vaultRoot: string;
  proj: string;
  sid: string;
}): Promise<boolean> {
  const vp = vaultPaths(a.vaultRoot, a.proj, a.sid);
  let content: string;
  try {
    content = await readFile(vp.inboxNote, "utf8");
  } catch (err) {
    // ENOENT(노트 자체가 아직 없음)만 "미소비 없음" 이다 — 그 밖의 읽기 실패(EACCES·EIO 등)는
    // 형제 probe(`pendingWork`)와 같은 방향(fail-closed)으로 보수적 true 를 반환한다. 여기서
    // false 로 흡수하면 노트를 읽을 수 없는 상태에서 stop 이 "잔여 없음" 으로 즉시 확정돼 사용자가
    // 체크해 둔 미소비 전송이 배너 교체로 소실된다(rework2 신규 발견).
    return errCode(err) !== "ENOENT";
  }
  const parsed = parseInbox(content);
  return parsed.actions.some((act) => act.kind === "fresh" || act.kind === "empty");
}

/**
 * 중지 안내형 노트 1회 교체 — `SessionManager` 의 `onStopApplied` 훅 대상.
 * 노트 자체가 없으면(첫 턴도 없이 중지되는 등) 빈 문자열 기준으로 새로 만든다.
 */
export async function writeStoppedNote(
  a: { vaultRoot: string; proj: string; sid: string },
  info: StopNoteInfo,
): Promise<void> {
  const vp = vaultPaths(a.vaultRoot, a.proj, a.sid);
  let content: string;
  try {
    content = await readFile(vp.inboxNote, "utf8");
  } catch {
    content = "";
  }
  const lines = content.length > 0 ? content.split("\n") : [];
  const rendered = renderStoppedNote(lines, info);
  await atomicWrite(vp.inboxNote, rendered.join("\n") + "\n");
}

/**
 * 재개 시 정상 스켈레톤 1회 복구 — `SessionManager` 의 `onResumeApplied` 훅 대상.
 * `healLayout` 을 중지 노트 내용에 그대로 적용하면 팔레트·send 를 되살리고 보존된 초안·기록은
 * 그대로 남는다(중지 노트도 compose 센티널·기록 앵커를 보존하므로 파싱이 정확히 맞물린다).
 */
export async function restoreActiveNote(
  a: { vaultRoot: string; proj: string; sid: string },
  data: { caps: EngineCaps; warnings: readonly string[]; notices: readonly NoticeEntry[] },
): Promise<void> {
  const vp = vaultPaths(a.vaultRoot, a.proj, a.sid);
  let content: string;
  try {
    content = await readFile(vp.inboxNote, "utf8");
  } catch {
    content = "";
  }
  const lines = content.length > 0 ? content.split("\n") : [];
  const healed = healLayout(lines, {
    paletteEnabled: true,
    caps: data.caps,
    warnings: data.warnings,
    notices: data.notices,
  });
  ensureBlankSend(healed.lines);
  await atomicWrite(vp.inboxNote, healed.lines.join("\n") + "\n");
}
