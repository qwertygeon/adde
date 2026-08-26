/**
 * 대화 이벤트를 사람이 읽는 줄로 렌더(FR-043) — `logs <proj> <sid>` 기본 출력. 현행
 * `core/transcript.ts:renderEvent` 의 렌더 규칙을 확장 이식한다.
 */
import { readEvents } from "./events.js";
import type { AddeEvent, RecordCtx } from "./types.js";
import { sanitizeEngineText } from "../shared/mask.js";

export function renderEventLine(e: AddeEvent): string {
  const ts = e.ts;
  switch (e.t) {
    case "turn_start":
      return `[${ts}] turn ${e.turn} 시작 — 입력: ${e.input.text}`;
    case "session":
      return `[${ts}] session ${e.resumed ? "재개" : "신규"} (engineRef=${e.engineRef})`;
    case "text":
      return `[${ts}] assistant(부분): ${e.delta}`;
    case "text_final":
      return `[${ts}] assistant: ${typeof e.text === "string" ? e.text : `(blob ${e.text.blob}, ${e.text.bytes}B)`}`;
    case "thinking":
      return `[${ts}] thinking: ${e.delta}`;
    case "tool_call":
      return `[${ts}] tool_call ${e.name} (id=${e.id})`;
    case "tool_result":
      return `[${ts}] tool_result (id=${e.id})${e.isError ? " [오류]" : ""}`;
    case "permission":
      // 엔진 유래 tool 텍스트 살균 — 이미 살균된 값을 재적용해도 무해(개행 삽입 방어의 소비측 이중화).
      return `[${ts}] permission 요청: ${sanitizeEngineText(e.tool)} (reqId=${e.reqId})`;
    case "permission_decision":
      return `[${ts}] permission 결정: ${e.decision} (reqId=${e.reqId})${e.reason ? ` — ${e.reason}` : ""}`;
    case "usage":
      return `[${ts}] usage: input=${e.input} output=${e.output}${e.costUsd ? ` cost=$${e.costUsd}` : ""}`;
    case "state":
      return `[${ts}] state → ${e.status} (${e.reason})`;
    case "note":
      return `[${ts}] note(${e.kind}): ${e.message}`;
    case "error":
      return `[${ts}] error${e.fatal ? "(fatal)" : ""}: ${e.message}`;
    case "delivered":
      return `[${ts}] delivered via ${e.surface} → ${e.address}`;
    case "turn_end":
      return `[${ts}] turn ${e.turn} 종료(${e.stopReason})`;
    default:
      return `[${ts}] ${JSON.stringify(e)}`;
  }
}

/** 세션 이벤트 렌더 라인을 순서대로 반환. */
export async function renderSessionLog(ctx: RecordCtx): Promise<string[]> {
  const lines: string[] = [];
  for await (const e of readEvents(ctx)) lines.push(renderEventLine(e));
  return lines;
}

export interface FollowSessionLogOptions {
  /** 신규 라인 청크 sink(호출측이 stdout 등에 쓴다). */
  onData: (chunk: string) => void;
  /** abort 시 즉시 정지. */
  signal: AbortSignal;
  /** 폴링 주기(ms, 기본 500). */
  pollMs?: number;
  /** 이미 방출한 라인 수(중복 방지 시작점) — 미지정 시 0. */
  fromLineCount?: number;
}

/**
 * 대화 이벤트 로그 라이브 추적(`logs <proj> <sid> -f`, FR-043 "실시간 추적"). 매 관측(poll)마다
 * `renderSessionLog` 로 전체 이력을 다시 렌더해 이전 관측 대비 신규 라인만 방출한다 — 세대 파일
 * 회전(`events-NNNN.jsonl`)은 새 파일명이라 단일 파일 바이트 tail(`core/log-follow.ts`)로는 자연히
 * 이어읽을 수 없지만, `readEvents` 가 세대를 순서대로 순회하므로 이 방식은 회전을 별도 분기 없이
 * 흡수한다. `signal` abort 시 즉시 정지(잔여 관측 없음).
 */
export async function followSessionLog(
  ctx: RecordCtx,
  opts: FollowSessionLogOptions,
): Promise<void> {
  const pollMs = opts.pollMs ?? 500;
  let lastCount = opts.fromLineCount ?? 0;
  if (opts.signal.aborted) return;
  await new Promise<void>((resolve) => {
    let stopped = false;
    let observing = false;
    const observe = (): void => {
      if (stopped || observing) return;
      observing = true;
      void renderSessionLog(ctx)
        .then((lines) => {
          if (lines.length > lastCount) {
            opts.onData(lines.slice(lastCount).join("\n") + "\n");
            lastCount = lines.length;
          }
        })
        .catch(() => {
          // 일시적 읽기 경합(세대 회전 중 파일 부재 등) — 이번 관측만 skip, 다음 폴에서 수렴.
        })
        .finally(() => {
          observing = false;
        });
    };
    const timer = setInterval(observe, pollMs);
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      resolve();
    };
    opts.signal.addEventListener("abort", stop, { once: true });
  });
}
