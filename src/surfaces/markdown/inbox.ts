/**
 * markdown Surface(L4) — 3존 입력 노트 순수 파싱. 현행
 * `src-adapters/markdown.ts` 의 순수 함수(파싱·마커·팔레트)를 이식하되, 출력 소유(v1 의 out 노트
 * 렌더·전송 아카이브)는 제거되고 마커가 **턴 노트로의 링크**로 전이한다.
 */
import type { EngineCaps } from "../../engines/types.js";
import { sanitizeEngineText } from "../../shared/mask.js";
import { isNoticeContentLine, renderNoticeZone } from "./notices.js";
import type { NoticeEntry } from "../../core/session-store.js";

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
/** 상태 존 경계 — 세션 경고를 표시하는 기계 소유 영역. 경고가 없으면 이 줄째로 존재하지 않는다. */
export const STATUS_SENTINEL = "<!-- adde:status -->";
/** 안내 존 경계(신규, FR-013) — 안내가 없으면 이 줄째로 존재하지 않는다(상태 존과 동형). */
export const NOTICES_SENTINEL = "<!-- adde:notices -->";
/** 팔레트 존 경계(신규, ADR-006) — 그룹 머리글을 기계 소유 영역 안에 둬 판정을 위치 기반으로 만든다. */
export const PALETTE_SENTINEL = "<!-- adde:palette -->";
/** 중지·떨어짐·제거됨 노트 경계(신규, ADR-009) — `renderStoppedNote` 가 쓰는 3용도 공용 마커. */
export const STOPPED_SENTINEL = "<!-- adde:stopped -->";

export function matchComposeSentinel(line: string): boolean {
  return line.trim() === COMPOSE_SENTINEL;
}
export function matchRecordsAnchor(line: string): boolean {
  return line.trim() === RECORDS_ANCHOR;
}
export function matchStatusSentinel(line: string): boolean {
  return line.trim() === STATUS_SENTINEL;
}
export function matchNoticesSentinel(line: string): boolean {
  return line.trim() === NOTICES_SENTINEL;
}
export function matchPaletteSentinel(line: string): boolean {
  return line.trim() === PALETTE_SENTINEL;
}
export function matchStoppedSentinel(line: string): boolean {
  return line.trim() === STOPPED_SENTINEL;
}

/**
 * 안내 존의 실제 줄 범위(`[start, end)` — start=센티널 줄, end=다음 기지 존 경계 또는 EOF).
 * 존재하지 않으면 null. **위치**로 판정한다 — 라벨 내부 개행 breakout 으로 만들어진 위조
 * 체크박스 줄은 `isNoticeContentLine` 같은 패턴 매칭과 일치하지 않을 수 있으므로(위조 줄은 정식
 * 렌더 형태를 따르지 않는다), 패턴이 아니라 범위 안에 있다는 사실 자체로 걸러야 안전하다.
 * `parseInbox`(액션 인식 배제)·`healLayout`(초안 슬라이스 배제) 가 이 함수를 공유해 같은 경계를
 * 쓴다(보안 검토 SEC-008 — 종전엔 두 곳이 서로 다른 기준을 썼다).
 */
export function noticeZoneRange(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => matchNoticesSentinel(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (
      matchPaletteSentinel(l) ||
      matchComposeSentinel(l) ||
      matchStatusSentinel(l) ||
      matchRecordsAnchor(l) ||
      matchStoppedSentinel(l)
    ) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 팔레트 그룹 머리글(체크박스 아닌 줄) — 액션으로 파싱되지 않고 초안으로도 취급되지 않는다. */
export function isPaletteGroupHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "**records**" || trimmed === "**session**";
}

const STATUS_LINE_PREFIX = "> ⚠️ ";
/** 상태 존의 경고 줄인가 — 치유가 이 줄을 초안으로 오인해 프롬프트에 실어 보내지 않도록 판별한다. */
export function isStatusWarningLine(line: string): boolean {
  return line.startsWith(STATUS_LINE_PREFIX);
}

/**
 * 상태 존 렌더 — 세션 경고의 순수 파생물이라 별도 상태를 만들지 않는다(노트와 레코드가 어긋날 수 없다).
 * 체크박스를 쓰지 않는 인용 줄이다: 체크박스는 액션으로 파싱되고, 사용자가 조작할 수 있다는 잘못된
 * affordance 를 준다. 경고 본문에는 엔진 유래 텍스트가 섞일 수 있어(`resume-failed:` 등) 삽입 전
 * 살균한다 — 개행을 접어 위조 체크박스·위조 종단 마커 줄을 만들 수 없게 한다(승인 노트와 동일 자세).
 */
export function renderStatusZone(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return [STATUS_SENTINEL, ...warnings.map((w) => `${STATUS_LINE_PREFIX}${sanitizeEngineText(w)}`)];
}

/**
 * 팔레트 — 기능 카테고리 그룹으로 구조화: **기록 그룹**(archive) / **세션 그룹**
 * (compact·clear·stop·resume). `caps.compact==="none"` 이면 compact 만 제거하고 그룹은 유지하며,
 * `enabled=false`(markdown.palette=off) 이면 존 전체를 렌더하지 않는다. 그룹 머리글은 체크박스가
 * 아닌 줄이라 액션으로 파싱되지 않는다. `resume` 은 중지·떨어짐 세션 재개로 의미가
 * 바뀌었다 — 기존 "자기 세션 엔진 재개" 항목은 소멸했다(FR-024 문서 반영 대상).
 */
export function renderPalette(caps: EngineCaps, enabled: boolean): string[] {
  if (!enabled) return [];
  const lines = [PALETTE_SENTINEL, "**records**", "- [ ] 🗄️ archive", "**session**"];
  if (caps.compact !== "none") lines.push("- [ ] 🗜️ compact");
  lines.push("- [ ] 🧹 clear", "- [ ] ⏹️ stop", "- [ ] ♻️ resume");
  return lines;
}

/** 기록 존 2단계 마커 1단계 — 전송 접수. */
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
  controlKind?: "clear" | "compact" | "resume" | "stop";
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
  // 안내 존 줄은 위치만으로 배제한다(SEC-008) — 위조 체크박스(라벨 개행 breakout)가 팔레트·send
  // 액션으로 오인되는 것을 막는다. 안내 존은 렌더 순서상 언제나 compose/records 보다 앞에 오므로
  // 정상 노트에서는 이 배제가 아무 영향이 없다.
  const noticeRange = noticeZoneRange(lines);

  const segment = (end: number): string => lines.slice(segmentStart, end).join("\n").trim();

  for (let i = 0; i < lines.length; i++) {
    if (noticeRange && i >= noticeRange.start && i < noticeRange.end) continue;
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
    if (core === "clear" || core === "compact" || core === "stop") {
      if (checked) actions.push({ kind: "control", controlKind: core, text: "", lineIndex: i });
      segmentStart = i + 1;
      continue;
    }
    const rm = /^resume(?:\s+(\S+))?$/i.exec(labelBody(label));
    if (rm) {
      if (checked) {
        // 인자 없는 `resume` 는 팔레트가 렌더하는 형태다(팔레트 4종은 모두 인자 없음) — 엔진 재개로
        // 해석한다. 이전 구현은 인자 없는 경우를 세션 목록 요청으로 매핑했으나 그 종류를 처리하는
        // 곳이 없어, 사용자가 팔레트의 재개를 체크하면 체크만 풀리고 아무 일도 일어나지 않았다.
        const action: InboxAction = {
          kind: "control",
          controlKind: "resume",
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
  /** 세션 레코드의 경고 — 상태 존으로 렌더된다. 비었거나 미지정이면 존을 만들지 않는다. */
  warnings?: readonly string[];
  /** 세션 레코드의 안내 — 안내 존으로 렌더된다(신규, FR-013). 비었거나 미지정이면 존을 만들지 않는다. */
  notices?: readonly NoticeEntry[];
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
  const { paletteEnabled, caps, newRecords = [], warnings = [], notices = [] } = opts;
  const parsed = parseInbox(lines.join("\n"));

  const composeIdx = parsed.composeIndex;
  const draftStart = composeIdx !== null ? composeIdx + 1 : 0;
  const sendIdx = findSendIndex(lines);
  const draftEnd = sendIdx === -1 ? lines.length : sendIdx;
  const noticeRange = noticeZoneRange(lines);
  const sliceStart = Math.min(draftStart, draftEnd);

  const draftLines = lines.slice(sliceStart, draftEnd).filter((line, i) => {
    const idx = sliceStart + i;
    // 안내 존 범위는 위치로도 배제한다(SEC-008) — 라벨 개행 breakout 으로 만든 위조 줄은
    // 아래 패턴 매칭(`isNoticeContentLine`)과 일치하지 않아도 이 범위 안에 있다는 사실만으로
    // 걸린다(패턴 매칭과 이중 방어).
    if (noticeRange && idx >= noticeRange.start && idx < noticeRange.end) return false;
    if (matchComposeSentinel(line) || matchRecordsAnchor(line)) return false;
    // 작성 경계가 없는 손상 노트에서는 초안 슬라이스가 0번째부터 시작해 상태·안내·팔레트 존까지
    // 삼킨다 — 걸러내지 않으면 그 내용이 다음 지시 본문으로 엔진에 전달된다.
    if (matchStatusSentinel(line) || isStatusWarningLine(line)) return false;
    if (matchNoticesSentinel(line) || isNoticeContentLine(line)) return false;
    if (matchPaletteSentinel(line) || isPaletteGroupHeader(line)) return false;
    if (isTerminalMarker(line)) return false;
    if (paletteEnabled && isCanonicalPaletteLine(line, caps)) return false;
    return true;
  });
  while (draftLines.length > 0 && draftLines[0]!.trim() === "") draftLines.shift();
  while (draftLines.length > 0 && draftLines[draftLines.length - 1]!.trim() === "")
    draftLines.pop();

  const existingRecords = lines.filter((line) => isTerminalMarker(line));

  // 존 순서(ASM-010 확정): 경고 존 → 안내 존 → 팔레트 존 → 작성 경계 → send → 기록 존.
  const rebuilt: string[] = [];
  rebuilt.push(...renderStatusZone(warnings));
  rebuilt.push(...renderNoticeZone(notices));
  if (paletteEnabled) rebuilt.push(...renderPalette(caps, true));
  rebuilt.push(
    COMPOSE_SENTINEL,
    ...draftLines,
    blankSendLine(),
    RECORDS_ANCHOR,
    ...newRecords,
    ...existingRecords,
  );

  // 판정 기준은 "쓰기가 파일 바이트를 바꾸는가" 다 — 호출자는 false 면 쓰기를 건너뛴다.
  // 배열 원소 비교는 쓰지 않는다: 호출자가 넘기는 `lines` 는 개행으로 끝나는 파일을 split 한
  // 결과라 말미에 빈 원소가 하나 붙는데 `rebuilt` 는 그것을 만들지 않아, 내용이 같아도 길이가
  // 항상 어긋나 changed 가 무조건 true 가 된다(그 상태에서는 idle 노트가 poll 마다 재기록됐다).
  // 직렬화 형태끼리 비교하면 말미 개행 유무와 무관하게 실제 바이트 변화만 잡힌다.
  const changed = rebuilt.join("\n") + "\n" !== lines.join("\n");
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

/** 팔레트 액션 체크박스(그룹·caps 무관) — `renderStoppedNote` 는 `caps` 를 받지 않으므로 정확한
 * 그룹 구성 대신 라벨 패턴으로 배제한다(손상 노트에서만 의미 있는 방어적 필터). */
const PALETTE_ACTION_LINE =
  /^\s*-\s*\[[ xX]\]\s+(?:🗄️\s*archive|🗜️\s*compact|🧹\s*clear|⏹️\s*stop|♻️\s*resume(?:\s+\S+)?)\s*\r?$/;

/** 중지·떨어짐·제거됨 노트의 고정 배너 3용도 — `extras` 는 승계 등 세션 레코드만 아는 부가 안내. */
function stoppedBannerLines(info: {
  kind: "stopped" | "detached" | "removed";
  reason: string;
  extras?: string[];
}): string[] {
  const lines: string[] = [STOPPED_SENTINEL];
  if (info.kind === "removed") {
    lines.push(
      "> 🗑️ 이 세션은 목록에서 제거되었습니다 — 대화 기록·노트는 보존되며 재생성 명령이 필요하지 않습니다.",
    );
  } else if (info.kind === "detached") {
    lines.push(
      "> ⚠️ 이 세션은 재개에 실패해 **감시되지 않습니다** — 이 노트의 체크박스는 처리되지 않습니다.",
    );
  } else {
    lines.push(
      "> ⏹️ 이 세션은 중지되어 **감시되지 않습니다** — 이 노트의 체크박스는 처리되지 않습니다.",
    );
  }
  if (info.reason.length > 0) lines.push(`> 사유: ${sanitizeEngineText(info.reason)}`);
  if (info.kind !== "removed") {
    lines.push(
      "> 재개: 활성 세션 입력 노트의 팔레트에서 `♻️ resume` 체크 · 터미널에서 `adde session resume <proj> <sid>`",
    );
  }
  for (const extra of info.extras ?? []) lines.push(`> ${sanitizeEngineText(extra)}`);
  return lines;
}

/**
 * 중지·떨어짐·제거됨 입력 노트 순수 렌더러(ADR-009 — 단일 렌더러 3용도 재사용, FR-018·FR-019·FR-020).
 * 팔레트·전송·안내·경고 체크박스가 **하나도 없다**(기록 그룹 포함) — 감시되지 않는 노트에 남은
 * 체크박스는 영구히 소비되지 않는다. 과거 초안·기록 존은 보존한다. 재개 시 `healLayout` 이 정상
 * 스켈레톤을 1회 복구한다(`renderStoppedNote` 는 그 반대 방향 — 되돌리기가 아니라 진입만 담당).
 */
export function renderStoppedNote(
  lines: readonly string[],
  info: { kind: "stopped" | "detached" | "removed"; reason: string; extras?: string[] },
): string[] {
  const parsed = parseInbox(lines.join("\n"));
  const composeIdx = parsed.composeIndex;
  const recordsIdx = parsed.recordsIndex;
  const draftStart = composeIdx !== null ? composeIdx + 1 : 0;
  const draftEnd = recordsIdx !== null ? recordsIdx : lines.length;

  const draft = lines.slice(Math.min(draftStart, draftEnd), draftEnd).filter((line) => {
    if (
      matchComposeSentinel(line) ||
      matchRecordsAnchor(line) ||
      matchStatusSentinel(line) ||
      matchNoticesSentinel(line) ||
      matchPaletteSentinel(line) ||
      matchStoppedSentinel(line)
    )
      return false;
    if (isStatusWarningLine(line) || isNoticeContentLine(line) || isPaletteGroupHeader(line))
      return false;
    if (isTerminalMarker(line) || PALETTE_ACTION_LINE.test(line)) return false;
    const cb = CHECKBOX.exec(line);
    if (cb && isSendLabel(cb[2]!.trim())) return false; // 빈 send 체크박스는 제거.
    return true;
  });
  while (draft.length > 0 && draft[0]!.trim() === "") draft.shift();
  while (draft.length > 0 && draft[draft.length - 1]!.trim() === "") draft.pop();

  const existingRecords = lines.filter((line) => isTerminalMarker(line));

  return [
    ...stoppedBannerLines(info),
    COMPOSE_SENTINEL,
    ...draft,
    RECORDS_ANCHOR,
    ...existingRecords,
  ];
}
