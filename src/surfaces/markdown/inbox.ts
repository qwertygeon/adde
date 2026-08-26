/**
 * markdown Surface(L4) — 3존 입력 노트 순수 파싱(FR-024·FR-036·FR-038·FR-039). 현행
 * `src-adapters/markdown.ts` 의 순수 함수(파싱·마커·팔레트)를 이식하되, 출력 소유(v1 의 out 노트
 * 렌더·전송 아카이브)는 제거되고 마커가 **턴 노트로의 링크**로 전이한다(ADR-014).
 */
import type { EngineCaps } from "../../engines/types.js";

/** 체크박스 라인: `- [ ]`/`- [x]` + 라벨. CRLF 저장 노트도 허용(`\r?$`). */
const CHECKBOX = /^\s*-\s*\[([ xX])\]\s+(.*)\r?$/;

function labelBody(label: string): string {
  return label.replace(/^[^\p{L}]+/u, "");
}
function labelCore(label: string): string {
  return labelBody(label).toLowerCase();
}
function isSendLabel(label: string): boolean {
  return labelCore(label) === "send";
}

// --- 3존 상수 ------------------------------------------------------------

export const COMPOSE_SENTINEL = "<!-- adde:compose -->";
export const RECORDS_ANCHOR = "<!-- adde:records -->";

export function matchComposeSentinel(line: string): boolean {
  return line.trim() === COMPOSE_SENTINEL;
}
export function matchRecordsAnchor(line: string): boolean {
  return line.trim() === RECORDS_ANCHOR;
}

/** 팔레트 4종(archive·clear·compact·resume, 인자 없음, ADR-030). `caps.compact==="none"` 이거나
 * `enabled=false`(markdown.palette=off) 이면 전체/해당 항목을 렌더하지 않는다. */
export function renderPalette(caps: EngineCaps, enabled: boolean): string[] {
  if (!enabled) return [];
  const lines = ["- [ ] 🗄️ archive", "- [ ] 🧹 clear"];
  if (caps.compact !== "none") lines.push("- [ ] 🗜️ compact");
  lines.push("- [ ] ♻️ resume");
  return lines;
}

/** 기록 존 2단계 마커 1단계 — 전송 접수(FR-036). */
export function sendingLine(envelopeId: string, stamp: string): string {
  return `- [x] ⏳ sending ${envelopeId} ${stamp}`;
}

/** 기록 존 2단계 마커 2단계 — 처리 완료(턴 노트로의 위키링크, ADR-017 파일명 규약). */
export function sentLine(turn: number, turnStartIso: string): string {
  const base = `${String(turn).padStart(4, "0")} ${turnStartIso
    .replace(/\.\d{3}Z$/, "")
    .replace(/Z$/, "")
    .replace(/:/g, "-")}`;
  return `- [x] ✅ sent [[${base}]]`;
}

export function emptyLine(): string {
  return "- [x] ⚠️ empty (no message — type your text above the send box)";
}

export function blankSendLine(): string {
  return "- [ ] 📤 send";
}

const SENT_MARKER = /^\s*-\s*\[[xX]\]\s+✅\s+sent\s+\[\[([^\]\s]+)\s+([^\]\s]+)\]\]\s*\r?$/;
export function matchSentMarker(line: string): { turn: string; ts: string } | null {
  const m = SENT_MARKER.exec(line);
  return m ? { turn: m[1]!, ts: m[2]! } : null;
}

const SENDING_MARKER = /^\s*-\s*\[[xX]\]\s+⏳\s+sending\s+(\S+)(?:\s+(\S+))?\s*\r?$/;
export function matchSendingMarker(line: string): { id: string; stamp?: string } | null {
  const m = SENDING_MARKER.exec(line);
  if (!m) return null;
  const result: { id: string; stamp?: string } = { id: m[1]! };
  if (m[2]) result.stamp = m[2];
  return result;
}

const TERMINAL_MARKER =
  /^\s*-\s*\[[ xX]\]\s+(?:✅\s+sent|⚠️?\s+empty|🗄️?\s+archived)(?=\s|\[\[|\r|$)/;
export function isTerminalMarker(line: string): boolean {
  return TERMINAL_MARKER.test(line);
}

export function archivedLine(count: number, stamp: string): string {
  return `- [x] 🗄️ archived ${count} ${stamp}`;
}

const EMPTY_MARKER = /^\s*-\s*\[[xX]\]\s+⚠️?\s+empty\b/;
const ARCHIVED_SUMMARY = /^\s*-\s*\[[xX]\]\s+🗄️?\s+archived\s+(\d+)\b/;

/** 기록 존 상한 접기(옵트인, FR-039) — 초과 시 최근 1건 + 기존 요약과 병합한 누계 요약 1줄. */
export function planRecordsCap(
  lines: string[],
  recordsStart: number,
  cap: number,
  stamp: string,
): { lines: string[]; changed: boolean } {
  if (cap <= 0) return { lines, changed: false };
  const strictIdx: number[] = [];
  const summaryIdx: number[] = [];
  let summarySum = 0;
  for (let i = recordsStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (matchSentMarker(line) || EMPTY_MARKER.test(line)) {
      strictIdx.push(i);
    } else {
      const m = ARCHIVED_SUMMARY.exec(line);
      if (m?.[1]) {
        summaryIdx.push(i);
        summarySum += Number(m[1]);
      }
    }
  }
  if (strictIdx.length <= cap) return { lines, changed: false };
  const KEEP = 1;
  const pruneStrict = strictIdx.slice(KEEP);
  const mergedTotal = summarySum + pruneStrict.length;
  const remove = [...pruneStrict, ...summaryIdx].sort((a, b) => b - a);
  const out = [...lines];
  for (const idx of remove) out.splice(idx, 1);
  out.splice(recordsStart + KEEP, 0, archivedLine(mergedTotal, stamp));
  return { lines: out, changed: true };
}

/** 기록 존 수동 정리(팔레트 archive) — strict 종단 마커를 전부 제거(비운다, FR-039). */
export function planRecordsClear(
  lines: string[],
  recordsStart: number,
): { lines: string[]; changed: boolean } {
  const remove: number[] = [];
  for (let i = recordsStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (matchSentMarker(line) || EMPTY_MARKER.test(line) || ARCHIVED_SUMMARY.test(line))
      remove.push(i);
  }
  if (remove.length === 0) return { lines, changed: false };
  const out = [...lines];
  for (const idx of [...remove].sort((a, b) => b - a)) out.splice(idx, 1);
  return { lines: out, changed: true };
}

export interface InboxAction {
  kind: "fresh" | "resume" | "empty" | "control" | "archive";
  lineIndex: number;
  text: string;
  segmentStart?: number;
  id?: string;
  stamp?: string;
  controlKind?: "clear" | "compact" | "resume" | "sessions";
  controlArg?: string;
}

export interface InboxParse {
  actions: InboxAction[];
  lines: string[];
  trailingNewline: boolean;
  composeIndex: number | null;
  recordsIndex: number | null;
}

/** 인박스 본문을 파싱해 액션 목록을 만든다(파일은 쓰지 않음, id 부여는 호출자 책임). */
export function parseInbox(content: string): InboxParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const actions: InboxAction[] = [];
  let segmentStart = 0;
  let composeIndex: number | null = null;
  let recordsIndex: number | null = null;

  const segment = (end: number): string => lines.slice(segmentStart, end).join("\n").trim();

  for (let i = 0; i < lines.length; i++) {
    if (matchComposeSentinel(lines[i]!)) {
      if (composeIndex === null) composeIndex = i;
      segmentStart = i + 1;
      continue;
    }
    if (matchRecordsAnchor(lines[i]!)) {
      if (recordsIndex === null) recordsIndex = i;
      continue;
    }
    const cb = CHECKBOX.exec(lines[i]!);
    if (!cb) continue;

    const checked = cb[1]!.toLowerCase() === "x";
    const label = cb[2]!.trim();
    const core = labelCore(label);

    const sending = matchSendingMarker(lines[i]!);
    if (sending) {
      const action: InboxAction = {
        kind: "resume",
        id: sending.id,
        text: segment(i),
        lineIndex: i,
        segmentStart,
      };
      if (sending.stamp) action.stamp = sending.stamp;
      actions.push(action);
      segmentStart = i + 1;
      continue;
    }
    if (isTerminalMarker(lines[i]!)) {
      segmentStart = i + 1;
      continue;
    }
    if (isSendLabel(label)) {
      if (checked) {
        const text = segment(i);
        actions.push(
          text.length > 0
            ? { kind: "fresh", text, lineIndex: i, segmentStart }
            : { kind: "empty", text: "", lineIndex: i },
        );
      }
      segmentStart = i + 1;
      continue;
    }
    if (core === "archive") {
      if (checked) actions.push({ kind: "archive", text: "", lineIndex: i });
      segmentStart = i + 1;
      continue;
    }
    if (core === "clear" || core === "compact") {
      if (checked) actions.push({ kind: "control", controlKind: core, text: "", lineIndex: i });
      segmentStart = i + 1;
      continue;
    }
    const rm = /^resume(?:\s+(\S+))?$/i.exec(labelBody(label));
    if (rm) {
      if (checked) {
        const action: InboxAction = {
          kind: "control",
          controlKind: rm[1] ? "resume" : "sessions",
          text: "",
          lineIndex: i,
        };
        if (rm[1]) action.controlArg = rm[1];
        actions.push(action);
      }
      segmentStart = i + 1;
      continue;
    }
  }

  return { actions, lines, trailingNewline, composeIndex, recordsIndex };
}

export interface HealLayoutOptions {
  paletteEnabled: boolean;
  caps: EngineCaps;
  newRecords?: string[];
}

export interface HealLayoutResult {
  lines: string[];
  changed: boolean;
}

function isCanonicalPaletteLine(line: string, caps: EngineCaps): boolean {
  const trimmed = line.trim();
  return renderPalette(caps, true).some(
    (l) => trimmed === l || trimmed === l.replace("[ ]", "[x]"),
  );
}

function findSendIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const cb = CHECKBOX.exec(lines[i]!);
    if (cb && isSendLabel(cb[2]!.trim())) return i;
  }
  return -1;
}

/**
 * inbox 구조 요소(팔레트·compose 센티널·빈 send·기록 앵커)를 canonical 구조로 리빌드한다
 * (존별 분류 후 전량 재구성 — 일부만 삭제돼도 초안·기존 기록을 유실 없이 보존, SC-024 Edge).
 */
export function healLayout(lines: string[], opts: HealLayoutOptions): HealLayoutResult {
  const { paletteEnabled, caps, newRecords = [] } = opts;
  const parsed = parseInbox(lines.join("\n"));

  const composeIdx = parsed.composeIndex;
  const draftStart = composeIdx !== null ? composeIdx + 1 : 0;
  const sendIdx = findSendIndex(lines);
  const draftEnd = sendIdx === -1 ? lines.length : sendIdx;

  const draftLines = lines.slice(Math.min(draftStart, draftEnd), draftEnd).filter((line) => {
    if (matchComposeSentinel(line) || matchRecordsAnchor(line)) return false;
    if (isTerminalMarker(line)) return false;
    if (paletteEnabled && isCanonicalPaletteLine(line, caps)) return false;
    return true;
  });
  while (draftLines.length > 0 && draftLines[0]!.trim() === "") draftLines.shift();
  while (draftLines.length > 0 && draftLines[draftLines.length - 1]!.trim() === "")
    draftLines.pop();

  const existingRecords = lines.filter((line) => isTerminalMarker(line));

  const rebuilt: string[] = [];
  if (paletteEnabled) rebuilt.push(...renderPalette(caps, true));
  rebuilt.push(
    COMPOSE_SENTINEL,
    ...draftLines,
    blankSendLine(),
    RECORDS_ANCHOR,
    ...newRecords,
    ...existingRecords,
  );

  const changed = rebuilt.length !== lines.length || rebuilt.some((l, i) => l !== lines[i]);
  return { lines: rebuilt, changed };
}

/** send 트리거가 하나도 없으면 최상단에 빈 send 를 추가(M8 이식) — 매번 새로 만들 필요 없게 한다. */
export function ensureBlankSend(lines: string[]): boolean {
  const hasUnchecked = lines.some((line) => {
    const cb = CHECKBOX.exec(line);
    return cb !== null && cb[1] === " " && isSendLabel(cb[2]!.trim());
  });
  if (hasUnchecked) return false;
  while (lines.length > 0 && lines[0] === "") lines.shift();
  lines.splice(0, 0, "", blankSendLine());
  return true;
}
