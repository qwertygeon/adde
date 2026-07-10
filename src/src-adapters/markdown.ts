/**
 * Markdown 소스 어댑터 — 파일 핸드셰이크(버튼 없는 채널).
 * 임의 마크다운 에디터/동기 도구(대표 예: Obsidian)에서 노트 파일 편집만으로 구동.
 * 인박스 노트 편집 + send 체크박스 → envelope → 큐.
 * 권한: approvals 노트에 ⏳ 블록 append → allow/deny 체크 감지 → 게이트 반영. 무응답 → 타임아웃 deny.
 * 출력: out/<id>.out 감시 → 마크다운 출력 노트(one-file-per-message, atomic).
 * 동기 내성: *.sync-conflict* 격리·상태 마커 멱등 자기쓰기 가드·tmp→rename.
 */
import { t, tFor } from "../shared/i18n.js";
import { errMsg, errCode } from "../shared/errors.js";
import { watch, existsSync, mkdirSync, statSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, rename, mkdir, stat, readdir, appendFile } from "node:fs/promises";
import { join, dirname, isAbsolute, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { isPathInside, normCasePath, pathsOverlap, expandTilde } from "../shared/paths.js";
import { atomicWrite as atomicWriteFile } from "../shared/fs-atomic.js";
import type { LaneConf } from "../shared/conf.js";
import { enqueue, hasId, readSidecar, pruneOut } from "../core/queue.js";
import type { RenderHint } from "../core/queue.js";
import {
  SYNC_PROVIDER_REGISTRY,
  SYNC_PROVIDER_IDS,
  resolveSyncProvider,
  UnsupportedSyncProviderError,
} from "./sync-provider.js";
import type { SyncProviderDescriptor } from "./sync-provider.js";
import { relocateOldFolders, migrateFlatToDated, migrateLegacyArchiveFile } from "./markdown-retention.js";
import { formatDateFolder, dateFolderFromStamp } from "../shared/date-folder.js";
import type { Envelope, ControlRequest } from "../shared/envelope.js";
import { readLedger, resolveResumeControl } from "../core/session-ledger.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import type {
  Source,
  DecisionCallback,
  Decision,
  SourceContext,
  SourceDescriptor,
  SourceValidateInput,
  SourceValidateResult,
  SourceDoctorInput,
  WizardCtx,
} from "./source.js";
import { ENQUEUE_FAIL_THRESHOLD } from "./source.js";
import { formatException } from "../shared/notify.js";
import type { NotifyT } from "../shared/notify.js";
import type { LaneAddOptions } from "../core/lane-config.js";
import type { DoctorCheck } from "../core/diagnostics.js";

const DEBOUNCE_MS = 150;
/**
 * fs.watch 가 놓친 편집을 보정하는 폴링 백스톱(B2) — 적응형. 활동 직후엔 base(빠른 반응),
 * 무변경이 이어지면 max 까지 확장해 24h 유휴 시 wakeup 을 줄인다(변경 감지 시 base 복귀).
 */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 10_000;
/** 폴 간격 확장 트리거 — 이만큼 연속 무변경이면 다음 간격을 2배(최대 POLL_MAX)로. */
const POLL_IDLE_STEPS = 3;
/** 내용 안정화 재확인 간격(B1) — 동기 중 잘린 파일 읽기 방지. */
const READ_SETTLE_MS = 50;
/** 정리(prune) 안전창 여유값 K=1 캘린더일 — out_retention_days >= retention_days+K 를 기동에서 강제한다. */
const SAFETY_MARGIN_DAYS = 1;
/** 이관 기준일(retention_days) 소비측 기본값 — 파서(conf.ts)는 미지정 시 undefined 를 보존, 여기서 적용. */
const DEFAULT_RETENTION_DAYS = 2;

// --- 순수 파싱 (테스트 대상) -------------------------------------------------

/** 동기 충돌 파일 판별 — 파싱·실행 금지 대상(Obsidian Sync/Syncthing 등). */
export function isConflictFile(filename: string): boolean {
  return /\.sync-conflict|conflicted copy|\.conflicted\./i.test(filename);
}

/** 체크박스 라인 파싱: `- [ ]`/`- [x]` + 라벨. */
// `\r?$` — CRLF 저장 노트(Windows 에디터·일부 동기 도구)의 라인 끝 \r 을 허용해 send/제어
// 트리거를 놓치지 않는다(`.` 는 \r 를 매칭하지 않으므로 명시 필요).
const CHECKBOX = /^\s*-\s*\[([ xX])\]\s+(.*)\r?$/;

/** 라벨 앞쪽의 이모지·기호·공백을 제거한 본문(대소문자 보존 — resume 인자의 세션 id 는 대문자 포함 가능). */
function labelBody(label: string): string {
  return label.replace(/^[^\p{L}]+/u, "");
}

/** 라벨 앞쪽의 이모지·기호·공백을 제거하고 소문자화한 코어 토큰. */
function labelCore(label: string): string {
  return labelBody(label).toLowerCase();
}

/** send 트리거 라벨 판별 — 코어가 정확히 'send'(부분일치 금지). */
function isSendLabel(label: string): boolean {
  return labelCore(label) === "send";
}

// --- 전송 스탬프 -------------------------------------------
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
  /** fresh=신규 트리거 · resume=`sending <id>` 재개 · empty=빈 트리거 · control=세션 제어 라벨
   *  · archive=수동 `🗄️ archive` 스윕(어댑터 로컬, 엔진 미경유). */
  kind: "fresh" | "resume" | "empty" | "control" | "archive";
  lineIndex: number;
  text: string;
  /** fresh/resume 세그먼트 본문 시작 라인(이전 경계+1) — 전송 시점 본문 아카이브 범위 [segmentStart, lineIndex). */
  segmentStart?: number;
  /** resume 시 기존 id. */
  id?: string;
  /** resume 시 sending 라인에 기록된 전송 스탬프(구버전 라인엔 없음). */
  stamp?: string;
  /** control 시 제어 종류·인자(resume 의 번호/세션 id). */
  controlKind?: "clear" | "compact" | "resume" | "sessions";
  controlArg?: string;
}

/** 아카이브 대상 sent 세그먼트 — 마커 라인·본문 시작·식별자(수동 스윕/전송시점 공용). */
export interface SentSegment {
  /** strict `✅ sent` 마커 라인 인덱스(경계, 유지 대상). */
  markerIndex: number;
  /** 본문 시작 라인(이전 경계+1). 본문 = lines[bodyStart, markerIndex). */
  bodyStart: number;
  id: string;
  stamp: string;
}

export interface InboxParse {
  actions: InboxAction[];
  lines: string[];
  trailingNewline: boolean;
  /** 파싱 시점에 이미 존재하던 strict `✅ sent [[stamp id]]` 세그먼트(레거시/이전 턴 — 수동 스윕 대상). */
  sentSegments: SentSegment[];
}

/** send 트리거 라인을 단계별 마커로 재작성하는 헬퍼(2단계 내구 마킹). */
// 스탬프는 id 뒤에 둔다 — 재개 파서가 sending 다음 첫 토큰을 id 로 읽는다.
export function sendingLine(id: string, stamp: string): string {
  return `- [x] ⏳ sending ${id} ${stamp}`;
}
// 위키링크 텍스트 = out 노트 basename(스탬프+id) — 노트 생성 시 링크가 해소된다.
export function sentLine(id: string, stamp: string): string {
  return `- [x] ✅ sent [[${outNoteBase(stamp, id)}]]`;
}
export function emptyLine(): string {
  return "- [x] ⚠️ empty (no message)";
}

/** 아카이브 적격 strict 마커 — sentLine 형식(`- [x] ✅ sent [[stamp id]]`)만. 캡처: 1=stamp, 2=id.
 * 앵커+키워드만 보는 `isTerminalMarker`(경계 판별)와 구분해, 수동 입력 `✅ sent`·레거시 `sent <id>`
 * (위키링크 없음)는 아카이브 대상에서 제외한다(초안 오삭제 방지). `\r?$` — CRLF 관용. */
const SENT_MARKER = /^\s*-\s*\[[xX]\]\s+✅\s+sent\s+\[\[([^\]\s]+)\s+([^\]\s]+)\]\]\s*\r?$/;
export function matchSentMarker(line: string): { stamp: string; id: string } | null {
  const m = SENT_MARKER.exec(line);
  return m ? { stamp: m[1]!, id: m[2]! } : null;
}

/** sending(크래시 재개) 앵커 마커 — `⏳` 앵커 + 체크됨(`[xX]`) 이중 게이트, id 필수·stamp 선택(레거시
 * in-flight 라인엔 stamp 가 없다). 앵커 없음/미체크/id 없음이면 null(호출부가 본문으로 보존). `\r?$` CRLF 관용. */
const SENDING_MARKER = /^\s*-\s*\[[xX]\]\s+⏳\s+sending\s+(\S+)(?:\s+(\S+))?\s*\r?$/;
export function matchSendingMarker(line: string): { id: string; stamp?: string } | null {
  const m = SENDING_MARKER.exec(line);
  if (!m) return null;
  const result: { id: string; stamp?: string } = { id: m[1]! };
  if (m[2]) result.stamp = m[2];
  return result;
}

/** 종단 마커(경계) 판별 — `✅ sent`/`⚠️ empty`/`🗄️ archived` 중 하나의 앵커+키워드 필수, tail·checked
 * 무관(레거시·수동 마커 호환). 키워드 뒤 word-boundary(공백·위키링크·EOL·CRLF)만 인정해 `sentiment`·
 * `emptying` 같은 접두 오매칭을 막는다. VS16(`⚠️`·`🗄️`)은 VS 없는 레거시 표기 호환을 위해 선택 허용. */
const TERMINAL_MARKER =
  /^\s*-\s*\[[ xX]\]\s+(?:✅\s+sent|⚠️?\s+empty|🗄️?\s+archived)(?=\s|\[\[|\r|$)/;
export function isTerminalMarker(line: string): boolean {
  return TERMINAL_MARKER.test(line);
}

/** 수동 `🗄️ archive` 스윕 완료 종단 라인. `archived` 는 경계 마커라 재파싱서 본문 오염 없음.
 * auto=true(config 자동 아카이브 ON) 면 `· auto` 부기 — 자동 아카이브 활성 표기(사용자 인지용). */
export function archivedLine(count: number, stamp: string, auto: boolean): string {
  return `- [x] 🗄️ archived ${count} ${stamp}${auto ? " · auto" : ""}`;
}

/**
 * sent 세그먼트 본문 이관 계획(순수) — 아카이브 append 텍스트 + 제거할 라인 범위.
 * 본문 = lines[bodyStart, markerIndex)(마커는 유지). 빈 본문은 멱등 skip(이미 이관됨/원래 빔).
 * 문서 순서(bodyStart 오름차순) 로 아카이브. splice 는 호출부가 bottom-up 으로 적용(인덱스 보존).
 */
export function planArchive(
  lines: string[],
  targets: SentSegment[],
): { text: string; ranges: Array<[number, number]> } {
  let text = "";
  const ranges: Array<[number, number]> = [];
  const sorted = [...targets].sort((a, b) => a.bodyStart - b.bodyStart);
  for (const seg of sorted) {
    const body = lines.slice(seg.bodyStart, seg.markerIndex).join("\n").trim();
    if (body.length === 0) continue;
    text += `\n## [[${outNoteBase(seg.stamp, seg.id)}]]\n\n${body}\n`;
    ranges.push([seg.bodyStart, seg.markerIndex]);
  }
  return { text, ranges };
}
/** 항상 준비되는 빈 send 트리거(M8) — 사용자가 매번 send 줄을 만들 필요 없게 한다.
 * 문서 관습(`- [ ] 📤 send`)과 동일 표기로 self-heal 라인의 시각 일관성을 맞춘다. */
export function blankSendLine(): string {
  return "- [ ] 📤 send";
}

/**
 * inbox 에 미체크 빈 `- [ ] 📤 send` 트리거가 하나도 없으면 하나 추가(M8, 상시 빈 send).
 * 이미 있으면 무변경(중복 방지). 추가는 미체크라 parseInbox 가 액션으로 삼지 않는다(오전송 없음).
 * 추가했으면 true(호출부가 write 여부 판단). lines 를 in-place 변경.
 * 삽입 위치는 **끝의 빈 줄들 앞** — split 의 트레일링 빈 요소와 blank send 사이에 공백줄이 끼어
 * 누적되는 것을 막는다(joinLines 와 함께 개행 위생 유지).
 */
export function ensureBlankSend(lines: string[]): boolean {
  const hasUnchecked = lines.some((line) => {
    const cb = CHECKBOX.exec(line);
    return cb !== null && cb[1] === " " && isSendLabel(cb[2]!.trim());
  });
  if (hasUnchecked) return false;
  let insertAt = lines.length;
  while (insertAt > 0 && lines[insertAt - 1] === "") insertAt--;
  lines.splice(insertAt, 0, blankSendLine());
  return true;
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
  const sentSegments: SentSegment[] = [];
  let segmentStart = 0;

  const segment = (end: number): string => lines.slice(segmentStart, end).join("\n").trim();

  for (let i = 0; i < lines.length; i++) {
    const cb = CHECKBOX.exec(lines[i]!);
    if (!cb) continue; // 일반 텍스트 — 세그먼트 본문

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
    // 종단 마커(경계): sent/empty/archived. strict `✅ sent [[stamp id]]` 는 아카이브 대상으로도 수집.
    if (isTerminalMarker(lines[i]!)) {
      const sm = matchSentMarker(lines[i]!);
      if (sm)
        sentSegments.push({ markerIndex: i, bodyStart: segmentStart, id: sm.id, stamp: sm.stamp });
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
      segmentStart = i + 1; // 체크/미체크 무관 경계
      continue;
    }
    // 수동 아카이브 트리거 `🗄️ archive`(어댑터 로컬 스윕, 엔진 미경유·항상 경계).
    // `archive`(트리거) vs `archived`(종단, 위 분기) — 정확 일치로 구분.
    if (core === "archive") {
      if (checked) actions.push({ kind: "archive", text: "", lineIndex: i });
      segmentStart = i + 1;
      continue;
    }
    // 세션 제어 라벨(send 와 동일 계약: 정확 일치·앞 이모지 허용·체크 시 트리거·항상 경계).
    // resume 은 인자 허용: `resume 2`(목록 번호)·`resume <세션id>`. 무인자 resume = 목록 조회.
    if (core === "clear" || core === "compact") {
      if (checked) {
        actions.push({ kind: "control", controlKind: core, text: "", lineIndex: i });
      }
      segmentStart = i + 1;
      continue;
    }
    // 인자는 소문자 core 가 아니라 본문에서 추출 — 세션 id 의 대문자를 보존해야 장부와 일치.
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
    // send/sent/sending/empty/제어 가 아닌 체크박스 → 본문(경계 아님, segmentStart 유지)
  }

  return { actions, lines, trailingNewline, sentSegments };
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
  timeoutMs: number = DEFAULT_GATE_TIMEOUT_MS,
): string {
  const detail = req.detail.replace(/\s+/g, " ").trim();
  const deadline = new Date(now.getTime() + timeoutMs);
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

/** resolvePaths 반환 — vault 경로 + 이관/정리 설정. */
interface MarkdownResolvedPaths {
  rootDir: string;
  inboxPath: string;
  approvalsDir: string;
  outboxDir: string;
  quarantineDir: string;
  /** 전용 아카이브 디렉터리 — `<archiveDir>/<YYYY-MM-DD>.md` 날짜 파일만 이 하위에 쓴다. */
  archiveDir: string;
  autoArchive: boolean;
  /** 로컬 백업 폴더(옵트인, expandTilde 적용). 미지정 = 이관 기능 off. */
  backupDir?: string;
  /** 이관 기준일(캘린더일). 미지정 시 DEFAULT_RETENTION_DAYS 적용. */
  retentionDays: number;
  /** state out/ prune 안전창(캘린더일, 옵트인). 미지정 = prune off. */
  outRetentionDays?: number;
  /** 동기화 제공자 id — 미지정 시 "local". */
  syncProvider: string;
}

/** root 상대 경로를 절대경로로 해소한다. 필수 키 누락 시 throw(fail-closed). */
function resolvePaths(conf: LaneConf): MarkdownResolvedPaths {
  const md = conf.markdown;
  if (!md?.root) throw new Error(t("markdown.confRootMissing"));
  if (!md.inbox) throw new Error(t("markdown.confInboxMissing"));
  const rootDir = md.root;
  const inboxPath = join(rootDir, md.inbox);
  const inboxDir = dirname(inboxPath);
  // 승인은 요청당 파일 디렉터리 — markdown.approvals 는 디렉터리(미지정 시 inbox 형제 approvals/).
  const approvalsDir = md.approvals ? join(rootDir, md.approvals) : join(inboxDir, "approvals");
  const outboxDir = md.outbox ? join(rootDir, md.outbox) : join(inboxDir, "out");
  const quarantineDir = join(inboxDir, ".conflicts");
  // 전용 아카이브 디렉터리 — 기존(v0.1.4 이하) 단일 파일 해석에서 디렉터리 해석으로 진화(오래된
  // 산출물을 오이관하지 않도록 아카이브를 vault 의 다른 파일과 겹치지 않는 전용 위치로 분리).
  // 지정 시 그 이름을 디렉터리로 + 전송시점 자동 아카이브 ON. 미지정 시 기본 디렉터리(수동
  // 라벨용) + 자동 OFF. 기존 단일 파일과의 경로 충돌은 ensureArchiveDirReady 가 흡수한다.
  const archiveDir = md.archive ? join(rootDir, md.archive) : join(inboxDir, "sent-archive");
  const autoArchive = md.archive !== undefined && md.archive.length > 0;
  const result: MarkdownResolvedPaths = {
    rootDir,
    inboxPath,
    approvalsDir,
    outboxDir,
    quarantineDir,
    archiveDir,
    autoArchive,
    retentionDays: md.retention_days ?? DEFAULT_RETENTION_DAYS,
    syncProvider: md.sync_provider ?? "local",
  };
  if (md.backup) result.backupDir = expandTilde(md.backup);
  if (md.out_retention_days !== undefined) result.outRetentionDays = md.out_retention_days;
  return result;
}

// --- 소스 정의(descriptor) 훅 — validate/doctorChecks/wizard -----------------

/**
 * markdown conf 검증 — root 부재/경로 중첩 경고. 판정 규칙은 기동 가드(start())와
 * 동일해야 한다(shared/paths 가 SSOT) — 생성 시점에 기동 시 거부될 조합을 미리 안내한다.
 */
function validateMarkdownConf(input: SourceValidateInput): SourceValidateResult {
  const warnings: string[] = [];
  const md = input.conf.markdown;

  if (!md?.root) {
    warnings.push(t("laneConfig.warn.mdRootMissingConf"));
  } else if (!existsSync(expandTilde(md.root))) {
    warnings.push(t("laneConfig.warn.mdRootNotFound", { path: expandTilde(md.root) }));
  }

  if (md?.root && md.inbox) {
    const root = expandTilde(md.root);
    const inboxPath = resolve(join(root, md.inbox));
    const inboxDir = dirname(inboxPath);
    const approvalsDir = resolve(
      md.approvals ? join(root, md.approvals) : join(inboxDir, "approvals"),
    );
    const outboxDir = resolve(md.outbox ? join(root, md.outbox) : join(inboxDir, "out"));
    const quarantineDir = resolve(join(inboxDir, ".conflicts"));
    const insideNorm = (child: string, parent: string): boolean =>
      isPathInside(normCasePath(child), normCasePath(parent));
    if (
      pathsOverlap(outboxDir, approvalsDir) ||
      pathsOverlap(approvalsDir, quarantineDir) ||
      pathsOverlap(outboxDir, quarantineDir) ||
      insideNorm(inboxPath, approvalsDir) ||
      insideNorm(inboxPath, outboxDir)
    ) {
      warnings.push(
        t("laneConfig.warn.mdPathOverlap", { inbox: inboxPath, approvals: approvalsDir, outbox: outboxDir }),
      );
    }
  }

  // 백업 활성 + 아카이브 미설정 → inbox 축적이 계속됨을 경고(침묵 금지 — 자동 활성은 채택하지 않음).
  if (md?.backup && (!md.archive || md.archive.length === 0)) {
    warnings.push(t("laneConfig.warn.mdBackupNoArchive"));
  }

  return { errors: [], warnings };
}

/** markdown doctor 진단 — root/inbox 존재·설정 확인. */
async function markdownDoctorChecks(input: SourceDoctorInput): Promise<DoctorCheck[]> {
  const name = t("doctor.markdown.name", { lane: input.lane });
  const mdRoot = input.conf.markdown?.root;
  if (!mdRoot) {
    return [
      {
        name,
        level: "FAIL",
        detail: t("doctor.markdown.rootMissing"),
        hint: t("doctor.markdown.rootMissingHint"),
      },
    ];
  }
  if (!existsSync(expandTilde(mdRoot))) {
    return [
      {
        name,
        level: "FAIL",
        detail: t("doctor.markdown.rootNotFound", { path: expandTilde(mdRoot) }),
        hint: t("doctor.markdown.rootNotFoundHint"),
      },
    ];
  }
  if (!input.conf.markdown?.inbox) {
    return [
      {
        name,
        level: "FAIL",
        detail: t("doctor.markdown.inboxMissing"),
        hint: t("doctor.markdown.inboxMissingHint"),
      },
    ];
  }
  return [{ name, level: "PASS", detail: t("doctor.markdown.ok") }];
}

/** markdown 위저드 필드 수집 — root/inbox/approvals/outbox 경로 프롬프트. */
async function collectMarkdownWizardFields(ctx: WizardCtx): Promise<Partial<LaneAddOptions>> {
  const fields: Partial<LaneAddOptions> = {};
  const askPath = ctx.askPath ?? ctx.ask;

  const root = await askPath(t("lane.prompt.root"), "");
  if (root) fields.root = root;
  const inbox = await askPath(t("lane.prompt.inbox"), "inbox.md");
  if (inbox) fields.inbox = inbox;
  const approvals = await askPath(t("lane.prompt.approvals"), "");
  if (approvals) fields.approvals = approvals;
  const outbox = await askPath(t("lane.prompt.outbox"), "");
  if (outbox) fields.outbox = outbox;

  return fields;
}

/** markdown 소스 정의 — SOURCE_REGISTRY 가 등록한다(index.ts). postCreateHint 는 미제공(생략). */
export const markdownDescriptor: SourceDescriptor = {
  factory: createMarkdownSource,
  validate: validateMarkdownConf,
  doctorChecks: markdownDoctorChecks,
  wizard: {
    collect: collectMarkdownWizardFields,
  },
  // renderOut 이 동일 노트 atomicWrite 라 재호출이 멱등 — 재시작 재전송이 안전하다(중복 노트 없음).
  deliveryIdempotent: true,
};

export function createMarkdownSource(cfg: SourceContext): Source {
  const tl = tFor(cfg.conf.lang);
  const {
    rootDir,
    inboxPath,
    approvalsDir,
    outboxDir,
    quarantineDir,
    archiveDir,
    autoArchive,
    backupDir,
    retentionDays,
    outRetentionDays,
    syncProvider,
  } = resolvePaths(cfg.conf);
  // 결정완료(allow/deny) 승인 파일을 이관하는 아카이브 서브디렉터리(M6). pending 만 top-level 에
  // 남겨 폴 dirSig·handleApprovals 스캔을 O(pending) 로 유지(누적 승인수 A 에 비례하지 않게).
  const decidedDir = join(approvalsDir, ".decided");
  // state/<lane>/retention-last-run — 이관·정리·마이그레이션 일간 게이트(날짜 문자열).
  const retentionLastRunFile = join(cfg.paths.stateDir, "retention-last-run");
  // 옵트인 게이트 타임아웃(초→ms) — 승인 블록 기한 표기·어댑터 로컬 타이머를 게이트와 동일 기준으로 맞춘다.
  const gateTimeoutMs =
    cfg.conf.gate_timeout_sec !== undefined
      ? cfg.conf.gate_timeout_sec * 1000
      : DEFAULT_GATE_TIMEOUT_MS;

  const decisionHandlers: DecisionCallback[] = [];
  const watchers: FSWatcher[] = [];
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSelfWrite = new Map<string, string>();
  // 폴링 백스톱(B2): 파일별 마지막 관측 시그니처(mtimeMs:size)와 인터벌·in-flight 추적.
  const lastFileSig = new Map<string, string>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollBusy = false;
  let pollOp: Promise<void> = Promise.resolve();
  let pollDelay = POLL_INTERVAL_MS; // 현재 적응형 폴 간격(무변경 누적 시 확장).
  let pollIdleTicks = 0; // 연속 무변경 폴 횟수.
  let inboxBusy = false;
  let running = false;
  // enqueue 연속 실패 추적 — 임계 도달 시 outbox 알림 1회, 성공 시 리셋.
  let consecutiveEnqueueFailures = 0;
  let enqueueAlertSent = false;
  // approvals 파일 변경을 직렬화(append·결정 재작성·타임아웃 경합 방지).
  let approvalsLock: Promise<void> = Promise.resolve();
  // watch 발 격리(fire-and-forget)도 체인으로 추적 — stop() 이 in-flight 격리를 대기
  // (teardown 뒤 살아남은 mkdir 이 정리된 임시 경로를 재생성하는 것 방지).
  let quarantineOp: Promise<void> = Promise.resolve();
  // in-flight inbox/approvals 처리 추적 — stop() 이 정리 완료를 대기.
  let inboxOp: Promise<void> = Promise.resolve();
  let approvalsOp: Promise<void> = Promise.resolve();
  // 기동 검증(start)에서 확정되는 동기화 제공자 — 초기값은 안전한 기본(local), 검증 통과 후 재대입.
  let resolvedProvider: SyncProviderDescriptor = SYNC_PROVIDER_REGISTRY["local"]!;
  // 이관·정리·마이그레이션 유지작업(fail-open) 추적 — stop() 이 정리 완료를 대기.
  let retentionOp: Promise<void> = Promise.resolve();

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

  // ts 는 전송 스탬프의 원본(SoT) — 호출자가 스탬프와 같은 순간의 값을 넘긴다.
  function normalize(id: string, text: string, ts: string, control?: ControlRequest): Envelope {
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
      ...(control ? { control } : {}),
    };
  }

  /** 제어 라벨 → ControlRequest 해석. resume 인자 해석은 채널 공통(resolveResumeControl). */
  async function resolveControl(action: InboxAction): Promise<ControlRequest> {
    const kind = action.controlKind!;
    if (kind !== "resume") return { kind };
    return resolveResumeControl(action.controlArg, await readLedger(cfg.paths));
  }

  async function readMaybe(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 내용 안정화 후 읽기(B1) — 동기 중 절반만 기록된 파일을 읽어 잘린 메시지를 보내는 것을 막는다.
   * 빠른 경로: read 전후 시그니처(mtime:size)가 같으면 읽는 동안 변경이 없었다는 뜻이라 즉시 반환
   * (정지 파일·atomic-rename 저장 = 대부분의 경우 → 지연·중복 read 없음). read 중 시그니처가
   * 바뀌었으면(쓰기 진행 중) 종전의 간격 2회 read 로 안정 재확인. 벽시계 대신 stat 비교라 클록 스큐
   * 영향이 없다. truncate·비원자 rewrite 는 크기·mtime 변경으로 fallback 에 잡힌다(동기도구는 atomic
   * rename 또는 truncate 저장이 일반적). 잔여: 동일 크기 in-place overwrite + coarse-mtime FS 의 드문
   * 조합은 fast-path 가 못 잡을 수 있으나, macOS(APFS, ns mtime)에선 무해하고 동기도구 저장 방식상 실무 위험 미미.
   * 변경이 계속되면 null(다음 이벤트 재시도).
   */
  async function readStable(filePath: string): Promise<string | null> {
    const sigBefore = await fileSig(filePath);
    if (sigBefore === null) return null;
    const content = await readMaybe(filePath);
    if (content === null) return null;
    const sigAfter = await fileSig(filePath);
    if (sigAfter === sigBefore) return content; // read 동안 변경 없음 → 안정 스냅샷

    // 쓰기 진행 중 — settle 후 재확인(잘린 내용 방지).
    await new Promise((r) => setTimeout(r, READ_SETTLE_MS));
    const second = await readMaybe(filePath);
    if (second === null || second !== content) return null;
    return second;
  }

  function joinLines(lines: string[], trailingNewline: boolean): string {
    // 멱등 트레일링 개행 — split 의 트레일링 빈 요소가 이미 개행을 만들므로, 무조건 "\n" 을 더하면
    // 재작성마다 개행이 하나씩 누적된다(inbox 비대화). 이미 개행으로 끝나면 그대로 둔다.
    const body = lines.join("\n");
    if (!trailingNewline) return body;
    return body.endsWith("\n") ? body : body + "\n";
  }

  async function handleInbox(): Promise<void> {
    if (inboxBusy) return;
    inboxBusy = true;
    try {
      const content = await readStable(inboxPath);
      if (content === null) return; // 부재 또는 변경 진행 중(B1) — 다음 이벤트 재시도
      if (lastSelfWrite.get(inboxPath) === content) return; // 자기쓰기 echo

      const { actions, lines, trailingNewline, sentSegments } = parseInbox(content);
      if (actions.length === 0) {
        // 액션이 없어도 상시 빈 send 유지(M8) — 초기·재기동·사용자 삭제 시 self-heal.
        // 미체크 추가라 재파싱서 액션이 되지 않고, echo 가드가 자기쓰기 재트리거를 막는다.
        if (ensureBlankSend(lines)) {
          await atomicWrite(inboxPath, joinLines(lines, trailingNewline));
        }
        return;
      }

      // Phase A: fresh→id 부여+sending 마킹, empty→마킹 (내구 기록 후 enqueue).
      // control 은 단일 단계(마킹 없이 enqueue→sent 종단) — 재구성 불가한 제어 정보라 sending
      // 재개 대상에서 제외하고, 크래시 시 라벨이 남아 재트리거되는 쪽을 택한다(멱등에 가까움).
      const pending: Array<{
        id: string;
        text: string;
        lineIndex: number;
        resume: boolean;
        stamp: string;
        ts: string;
        control?: ControlRequest;
        segmentStart?: number;
      }> = [];
      let dirtyA = false;
      for (const a of actions) {
        if (a.kind === "empty") {
          lines[a.lineIndex] = emptyLine();
          dirtyA = true;
        } else if (a.kind === "archive") {
          continue; // 수동 아카이브 — enqueue 미대상. Phase B 에서 스윕·종단 표기.
        } else if (a.kind === "control") {
          const id = randomUUID();
          const d = new Date();
          pending.push({
            id,
            text: `/${a.controlKind!}`,
            lineIndex: a.lineIndex,
            resume: false,
            stamp: formatStamp(d),
            ts: d.toISOString(),
            control: await resolveControl(a),
          });
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
            ...(a.segmentStart !== undefined ? { segmentStart: a.segmentStart } : {}),
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
            ...(a.segmentStart !== undefined ? { segmentStart: a.segmentStart } : {}),
          });
        }
      }
      const hasArchive = actions.some((a) => a.kind === "archive");
      // 상시 빈 send(M8)를 "이미 일어날 write" 에 태워 여분 write 를 피한다:
      //  - enqueue 대상이 없으면(pending 0 = empty-only) Phase A 가 유일 write → 여기서 보충.
      //  - pending 이 있으면 Phase B(sent write)에 태운다(아래). resume/control 은 Phase A 불필요.
      //  - 수동 아카이브가 있으면 Phase B 가 반드시 write 하므로 여기선 미보충(중복 write 회피).
      // 추가는 미체크라 재파싱서 액션 아님. 크래시 시 blank 는 무해.
      if (pending.length === 0 && !hasArchive && ensureBlankSend(lines)) dirtyA = true;
      if (dirtyA) await atomicWrite(inboxPath, joinLines(lines, trailingNewline));

      // enqueue (resume 이고 이미 존재하면 스킵) → 성공분만 종단 후보.
      const finalize: Array<{
        id: string;
        lineIndex: number;
        stamp: string;
        segmentStart?: number;
      }> = [];
      for (const p of pending) {
        try {
          if (p.resume && (await hasId(cfg.paths, p.id))) {
            finalize.push(p); // 이미 enqueue 됨 — 종단만
            continue;
          }
          await enqueue(cfg.paths, normalize(p.id, p.text, p.ts, p.control));
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
          // 임계 도달 시 1회 운영자 알림 — telegram 패턴과 일관.
          if (consecutiveEnqueueFailures >= ENQUEUE_FAIL_THRESHOLD && !enqueueAlertSent) {
            enqueueAlertSent = true;
            await alertEnqueueFailure(consecutiveEnqueueFailures);
          }
        }
      }

      // Phase B: enqueue 확정분을 sent 로 종단(인덱스로 먼저 표기 — splice 전이라 인덱스 유효).
      for (const f of finalize) lines[f.lineIndex] = sentLine(f.id, f.stamp);

      // 아카이브 계획 — 전송 시점 자동(config on) + 수동 스윕(🗄️ archive). ORDER 불변식:
      // 아카이브 append 를 inbox write(본문 splice) 보다 먼저 한다. 사이 크래시 시 본문이 양쪽에
      // 잔존해 재기동 시 `✅ sent` 경계로 재전송 없이 수렴(무해 중복 1). 역순은 본문 유실 창.
      let archiveText = "";
      let removeRanges: Array<[number, number]> = [];
      if (autoArchive || hasArchive) {
        // 이번 턴 확정 세그먼트(전송 시점 대상 — fresh/resume 만 segmentStart 보유).
        const finalizedSegs: SentSegment[] = finalize
          .filter((f) => f.segmentStart !== undefined)
          .map((f) => ({
            bodyStart: f.segmentStart!,
            markerIndex: f.lineIndex,
            id: f.id,
            stamp: f.stamp,
          }));
        // 수동 스윕은 이전 턴/레거시 sent 까지 전량, 자동만이면 이번 턴만.
        const targets = hasArchive ? [...sentSegments, ...finalizedSegs] : finalizedSegs;
        const plan = planArchive(lines, targets);
        archiveText = plan.text;
        removeRanges = plan.ranges;
      }

      // 수동 archive 트리거 라인 → 종단 표기(자동 ON 이면 · auto 부기). splice 전 인덱스로 반영.
      if (hasArchive) {
        const stamp = formatStamp(new Date());
        for (const a of actions) {
          if (a.kind === "archive")
            lines[a.lineIndex] = archivedLine(removeRanges.length, stamp, autoArchive);
        }
      }

      // write 필요 판정: 종단 마킹·아카이브 스윕·수동 표기 중 하나라도 있으면. 없고 전량 enqueue 실패면
      // 빈 send 만 별도 보장(드묾, 종전 else-if 동치).
      let needWrite = finalize.length > 0 || hasArchive || removeRanges.length > 0;
      if (!needWrite && pending.length > 0) needWrite = ensureBlankSend(lines);

      if (needWrite) {
        if (archiveText.length > 0) {
          // 전용 아카이브 디렉터리 하위 날짜 파일(아카이브 시점 로컬일).
          const archiveFile = join(archiveDir, `${formatDateFolder(new Date())}.md`);
          await mkdir(archiveDir, { recursive: true });
          await appendFile(archiveFile, archiveText, "utf8");
        }
        removeRanges.sort((a, b) => b[0] - a[0]); // bottom-up splice — 인덱스 보존
        for (const [s, e] of removeRanges) lines.splice(s, e - s);
        ensureBlankSend(lines); // 소모된 send 대체(멱등 — 이미 있으면 무변경)
        await atomicWrite(inboxPath, joinLines(lines, trailingNewline));
        if (finalize.length > 0) cfg.onInbound?.(); // injector 깨우기(in-process)
      }
    } finally {
      inboxBusy = false;
    }
  }

  /** 승인 파일 marker 의 종단 상태(allow/deny) — pending·부재는 null. 이동 판정의 SoT(파일 기반). */
  function approvalTerminalStatus(content: string): "allow" | "deny" | null {
    const m = PERM_MARKER.exec(content);
    if (!m) return null;
    const status = m[2];
    return status === "allow" || status === "deny" ? status : null;
  }

  /**
   * 종단(allow/deny) 승인 파일을 .decided/ 로 이동(M6). 종단 판정은 파일 marker(위) 기반이라
   * permTimers(비영속, 재기동 시 빔) 에 의존하지 않는다 — 재기동 후 잔존 종단 파일도 안전히 정리.
   * pending 파일은 절대 호출되지 않는다(게이트 무결성). 이동 실패는 보조(정리)라 로그 후 흡수.
   */
  async function moveToDecided(fn: string): Promise<void> {
    const src = join(approvalsDir, fn);
    // 결정(이관) 시점의 로컬일 날짜 폴더 — pending(top-level)과 구분되는 유일한 파티션 근거.
    const targetDir = join(decidedDir, formatDateFolder(new Date()));
    try {
      await mkdir(targetDir, { recursive: true });
      await rename(src, join(targetDir, fn));
      lastSelfWrite.delete(src);
    } catch (err) {
      console.error(t("log.markdown.decidedMoveError", { file: fn, error: errMsg(err) }));
      // 재시도 가능하게 echo 가드 해제 — 안 그러면 다음 스캔이 동일 content 로 skip 해 이동이 방치된다.
      lastSelfWrite.delete(src);
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
        if (fn === ".decided") continue; // 종단 아카이브 — 스캔 제외
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
        // 종단분은 .decided/ 로 이관 — 이번 패스에서 결정됐든(changed) 재기동 잔존 종단분이든 멱등 정리.
        const finalContent = parsed.changed ? parsed.newContent : content;
        if (approvalTerminalStatus(finalContent) !== null) await moveToDecided(fn);
      }
    });
  }

  async function quarantine(filename: string, srcDir: string): Promise<void> {
    try {
      await mkdir(quarantineDir, { recursive: true });
      await rename(join(srcDir, filename), join(quarantineDir, filename));
    } catch (err) {
      // ENOENT = watch 경로와 폴링 백스톱이 같은 파일을 겹쳐 시도(한쪽이 이미 격리) — 정상 경합, 무음.
      if (errCode(err) === "ENOENT") return;
      console.error(
        t("log.markdown.quarantineFail", {
          filename,
          error: errMsg(err),
        }),
      );
    }
  }

  /**
   * 아카이브 경로를 디렉터리로 준비한다. 동명 경로에 구버전(archive=파일 해석) 단일 파일이
   * 남아있으면 mkdir 전에 치운다 — backupDir 설정 시 백업으로 이관(하이브리드 마이그레이션
   * 본경로), 미설정 시 데이터 보존을 위해 `.legacy` 접미로 곁에 남긴다(무손실 우선, mkdir 이
   * 파일과 충돌해 fail-closed 하는 것보다 안전 방향).
   */
  async function ensureArchiveDirReady(dir: string, backup: string | undefined): Promise<void> {
    let existingIsFile = false;
    try {
      existingIsFile = (await stat(dir)).isFile();
    } catch {
      // 부재 — 정상 신규 경로
    }
    if (existingIsFile) {
      try {
        if (backup) {
          await migrateLegacyArchiveFile({ legacyArchivePath: dir, backupDir: backup });
        } else {
          await rename(dir, `${dir}.legacy`);
        }
      } catch (err) {
        console.error(t("log.markdown.legacyArchiveMoveError", { path: dir, error: errMsg(err) }));
      }
    }
    await mkdir(dir, { recursive: true });
  }

  /** 이관 기준일(오늘 로컬 − retentionDays, 캘린더일 문자열) — cutoff 이전(strict <)만 이관 대상. */
  function computeCutoffDate(now: Date, days: number): string {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    return formatDateFolder(cutoff);
  }

  /**
   * 일간 이관+정리+최초1회 마이그레이션 게이트 — "오늘(local) > last-run" 이면 1회 실행 후
   * last-run 갱신. backupDir·outRetentionDays 둘 다 미설정이면 진입하지 않는다(opt-in).
   * fail-open — 실패해도 폴·메시지 파이프라인은 지속되며, last-run 은 성공·실패 무관하게 갱신해
   * 같은 날 반복 재시도로 로그가 쌓이는 것을 막는다(다음 날 다시 시도).
   */
  async function runRetentionMaintenance(): Promise<void> {
    if (backupDir === undefined && outRetentionDays === undefined) return;
    const now = new Date();
    const todayStr = formatDateFolder(now);
    const lastRun = await readMaybe(retentionLastRunFile);
    if (lastRun === todayStr) return;

    try {
      if (backupDir !== undefined) {
        await migrateFlatToDated({ outboxDir, decidedDir });
        const cutoffDate = computeCutoffDate(now, retentionDays);
        await relocateOldFolders({
          roots: [
            {
              vaultDir: outboxDir,
              backupDir: join(backupDir, relative(rootDir, outboxDir)),
              unit: "folder",
            },
            {
              vaultDir: decidedDir,
              backupDir: join(backupDir, relative(rootDir, decidedDir)),
              unit: "folder",
            },
            {
              vaultDir: archiveDir,
              backupDir: join(backupDir, relative(rootDir, archiveDir)),
              unit: "file",
            },
          ],
          cutoffDate,
          materialize: (p) => resolvedProvider.ensureLocal(p),
        });
      }
      if (outRetentionDays !== undefined) {
        await pruneOut(cfg.paths, outRetentionDays, now);
      }
    } catch (err) {
      console.error(
        t("log.markdownRetention.maintenanceFail", { lane: cfg.lane, error: errMsg(err) }),
      );
    } finally {
      // 내부 state 파일 — inbox/approvals 자기쓰기 echo 가드(lastSelfWrite) 대상이 아니므로
      // 공용 atomicWriteFile 을 직접 사용(로컬 atomicWrite 래퍼는 vault 파일 전용).
      await atomicWriteFile(retentionLastRunFile, todayStr).catch((err: unknown) =>
        console.error(
          t("log.markdownRetention.lastRunWriteFail", { lane: cfg.lane, error: errMsg(err) }),
        ),
      );
    }
  }

  /** out/<id>.out (+ sidecar) → 출력 노트. injector 가 writeOut 직후 in-process 호출. */
  /** enqueue 연속 실패 임계 도달 시 outbox 에 1회 액션형 알림 노트. 채널이 파일이라 outbox 로 표면화. */
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

  async function renderOut(id: string, hint?: RenderHint): Promise<void> {
    // hint(injector 메모리) 있으면 디스크 재read 생략(M7). 없으면(크래시 flush) 디스크에서 읽는다.
    const text = hint ? hint.text : await readFile(join(cfg.paths.outDir, `${id}.out`), "utf8");
    // sidecar 읽기는 queue.readSidecar 로 일원화(부재·파손 → null = 메타 없이 진행).
    const sidecar = hint ? hint.sidecar : await readSidecar(cfg.paths, id);
    // 파일명 스탬프는 전송 시각(origin_ts) 유래 — 재렌더에도 결정론적.
    // origin_ts 부재(구버전 sidecar)는 종전 `<id>.md` 유지.
    const stamp = sidecar?.origin_ts ? stampFromIso(sidecar.origin_ts) : null;
    const noteName = stamp ? `${outNoteBase(stamp, id)}.md` : `${id}.md`;
    // stamp 파생 날짜 폴더(파티셔닝) — write-time 이 아닌 stamp 파생이라 재렌더해도 같은 폴더로
    // 귀결한다(멱등). stamp 부재(레거시 폴백)는 flat 유지.
    const noteDir = stamp ? join(outboxDir, dateFolderFromStamp(stamp)) : outboxDir;
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
    await atomicWrite(join(noteDir, noteName), `${header}${text}`);
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
  /** 폴 1회 — 변화(재트리거 또는 충돌 격리) 감지 시 true 반환(적응형 간격 리셋 신호). */
  async function pollOnce(): Promise<boolean> {
    if (!running || pollBusy) return false;
    pollBusy = true;
    let changed = false;
    try {
      const inboxSig = await fileSig(inboxPath);
      if (inboxSig !== null && lastFileSig.get(inboxPath) !== inboxSig) {
        lastFileSig.set(inboxPath, inboxSig);
        debounce(inboxPath, runInbox);
        changed = true;
      }
      const apprSig = await dirSig(approvalsDir);
      if (apprSig !== null && lastFileSig.get(approvalsDir) !== apprSig) {
        lastFileSig.set(approvalsDir, apprSig);
        debounce(approvalsDir, runApprovals);
        changed = true;
      }
      // 충돌 파일 격리 백스톱: inbox 파일 시그니처·approvals 시그니처는 "충돌 파일 생성" 을
      // 포착하지 못하므로(watch 가 생성 이벤트를 놓치면 영구 방치) 인박스 디렉터리를 직접 스캔.
      try {
        const entries = await readdir(dirname(inboxPath));
        for (const fn of entries) {
          if (isConflictFile(fn)) {
            await quarantine(fn, dirname(inboxPath));
            changed = true;
          }
        }
      } catch {
        // 디렉터리 부재 — 다음 폴에서 재시도
      }
      // 저빈도 이관·정리·마이그레이션 게이트 — 내부적으로 "오늘>last-run" 아니면 즉시 반환
      // (readMaybe 1회)이라 매 폴 tick 호출 비용은 무시할 수준.
      retentionOp = runRetentionMaintenance().catch((err: unknown) =>
        console.error(
          t("log.markdownRetention.maintenanceFail", { lane: cfg.lane, error: errMsg(err) }),
        ),
      );
    } finally {
      pollBusy = false;
    }
    return changed;
  }

  /**
   * 적응형 폴 스케줄러 — 무변경이 POLL_IDLE_STEPS 회 이어질 때마다 간격을 2배(최대 POLL_MAX)로
   * 확장하고, 변경 감지 시 base 로 즉시 복귀한다. setInterval 대신 self-reschedule 로 간격을 가변화.
   */
  function schedulePoll(): void {
    pollTimer = setTimeout(() => {
      pollOp = pollOnce()
        .then((changed) => {
          if (changed) {
            pollDelay = POLL_INTERVAL_MS;
            pollIdleTicks = 0;
          } else if (++pollIdleTicks >= POLL_IDLE_STEPS) {
            pollIdleTicks = 0;
            pollDelay = Math.min(pollDelay * 2, POLL_MAX_INTERVAL_MS);
          }
        })
        .catch((err: unknown) => console.error(t("log.markdown.pollError", { error: errMsg(err) })))
        .finally(() => {
          if (running) schedulePoll();
        });
    }, pollDelay);
    pollTimer.unref(); // 폴 백스톱이 이벤트 루프를 살려두지 않도록(heartbeat 와 동일).
  }

  async function start(): Promise<void> {
    if (!existsSync(rootDir)) {
      throw new Error(t("markdown.rootNotFound", { path: rootDir }));
    }

    // 입력 검증(C): 상대 경로(inbox/approvals/outbox)는 root 안에 머물러야 한다 — '..'·절대경로로
    // root 를 탈출하면 임의 위치 읽기/쓰기 위험 → fail-closed 기동 거부.
    for (const [name, rel] of [
      ["inbox", cfg.conf.markdown?.inbox],
      ["approvals", cfg.conf.markdown?.approvals],
      ["outbox", cfg.conf.markdown?.outbox],
      ["archive", cfg.conf.markdown?.archive],
    ] as const) {
      if (rel === undefined) continue;
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
        throw new Error(t("markdown.pathNotRelative", { name, rel }));
      }
    }

    // 제어 노트가 AI 작업폴더(cwd) 내부면 자기승인 위험 → fail-closed 기동 거부.
    const effectiveCwd =
      cfg.conf.cwd && cfg.conf.cwd.length > 0 ? resolve(cfg.conf.cwd) : process.cwd();
    for (const [name, p] of [
      ["inbox", inboxPath],
      ["approvals", approvalsDir],
      ["outbox", outboxDir],
      ["archive", archiveDir],
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
    const rArchive = resolve(archiveDir);
    const rQueueOut = resolve(cfg.paths.outDir);
    for (const [nameA, a, nameB, b] of [
      ["approvals", rApprovals, "outbox", rOutbox],
      ["approvals", rApprovals, "quarantine(.conflicts)", rQuarantine],
      ["outbox", rOutbox, "quarantine(.conflicts)", rQuarantine],
      // 아카이브 디렉터리는 inbox 와 동일해선 안 되고(자기 이관), 승인/출력/큐/격리 디렉터리 안이면
      // 안 된다(승인 오파싱·출력 혼입·dedup 훼손 위험). inbox 형제 위치(기본 sent-archive/)는
      // 허용 — dispatch 가 inbox 외 파일을 무시하므로 재처리 없음.
      ["archive", rArchive, "inbox", rInbox],
      ["archive", rArchive, "approvals", rApprovals],
      ["archive", rArchive, "outbox", rOutbox],
      ["archive", rArchive, "out(queue)", rQueueOut],
      ["archive", rArchive, "quarantine(.conflicts)", rQuarantine],
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

    // 백업 경로 역-overlap 가드 — vault·state·레인 경로와 겹치면 기동 거부.
    // vault 밖·절대·타 볼륨은 허용(inside-root 강제는 하지 않음).
    if (backupDir !== undefined) {
      const rBackup = resolve(backupDir);
      for (const [name, p] of [
        ["root", resolve(rootDir)],
        ["inbox", rInbox],
        ["approvals", rApprovals],
        ["outbox", rOutbox],
        ["archive", rArchive],
        ["quarantine(.conflicts)", rQuarantine],
        ["state(out)", rQueueOut],
        ["state(dir)", resolve(cfg.paths.stateDir)],
      ] as const) {
        if (pathsOverlap(rBackup, p)) {
          throw new Error(t("markdown.backupPathOverlap", { name, backup: rBackup, path: p }));
        }
      }
    }

    // 동기화 제공자 검증 — 미지원 값은 기동 거부(fail-closed).
    try {
      resolvedProvider = resolveSyncProvider(syncProvider);
    } catch (err) {
      if (err instanceof UnsupportedSyncProviderError) {
        throw new Error(
          t("markdown.syncProviderUnsupported", {
            value: err.value,
            supported: SYNC_PROVIDER_IDS.join(", "),
          }),
          { cause: err },
        );
      }
      throw err;
    }

    // 정리(prune) 활성 시 안전창 부등식 강제(여유값 K 는 SAFETY_MARGIN_DAYS).
    if (outRetentionDays !== undefined && outRetentionDays < retentionDays + SAFETY_MARGIN_DAYS) {
      throw new Error(
        t("markdown.outRetentionTooLow", {
          outRetentionDays,
          retentionDays,
          margin: SAFETY_MARGIN_DAYS,
        }),
      );
    }

    running = true;

    const inboxDir = dirname(inboxPath);

    const dispatch = (srcDir: string, filename: string): void => {
      if (isConflictFile(filename)) {
        quarantineOp = quarantineOp.then(() => quarantine(filename, srcDir));
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

    // out 렌더는 injector 가 renderOut() 으로 in-process 호출(out/ watch 제거).
    mkdirSync(cfg.paths.outDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    // 전용 아카이브 디렉터리 보장 — 동명 경로에 구버전 단일 파일이 남아있으면 먼저 치운다
    // (하이브리드 마이그레이션 본경로, 데이터 무손실 우선).
    await ensureArchiveDirReady(archiveDir, backupDir);

    // 백업 활성 + 아카이브 미설정 → inbox 축적이 계속됨을 경고(침묵 금지).
    if (backupDir !== undefined && !autoArchive) {
      try {
        await notify(tl("markdown.backupNoArchiveWarn"));
      } catch (err) {
        console.error(t("log.markdown.backupWarnNotifyFail", { error: errMsg(err) }));
      }
    }

    // 기동 시 기존 인박스/승인 노트 1회 처리(능동 세션 재개).
    runInbox();
    runApprovals();
    // 이관·정리·마이그레이션 일간 게이트 — fail-open, stop() 이 in-flight 완료를 대기.
    retentionOp = runRetentionMaintenance().catch((err: unknown) =>
      console.error(
        t("log.markdownRetention.maintenanceFail", { lane: cfg.lane, error: errMsg(err) }),
      ),
    );

    // 폴링 백스톱(B2): watch 가 이벤트를 놓쳐도 주기적으로 보정. inbox baseline seed 후 인터벌 시작.
    // approvals 는 디렉터리라 첫 폴에서 시그니처를 seed(첫 폴 1회 스캔은 멱등이라 무해).
    seedSig(inboxPath);
    pollDelay = POLL_INTERVAL_MS;
    pollIdleTicks = 0;
    schedulePoll();
  }

  async function stop(): Promise<void> {
    running = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    for (const w of watchers) w.close();
    watchers.length = 0;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    for (const t of permTimers.values()) clearTimeout(t);
    permTimers.clear();
    // in-flight 처리(폴 + approvals 락 체인 + inbox/approvals/격리/이관 op) settle 대기 —
    // 임시 디렉터리 정리 뒤 살아남은 쓰기가 ENOENT 를 내지 않도록.
    await pollOp.catch(() => {});
    await retentionOp.catch(() => {});
    await approvalsLock.catch(() => {});
    await inboxOp.catch(() => {});
    await approvalsOp.catch(() => {});
    await quarantineOp.catch(() => {});
  }

  /**
   * 요청당 승인 파일 경로(D). reqId 는 ADDE 가 [A-Za-z0-9_-] charset 으로 생성하는 per-call
   * 고유키(client.ts mintPermId)지만, 경로 탈출은 방어심화로 항상 차단한다: 승인 파일은
   * approvalsDir 의 *직속 자식* 이어야 하며 `..`·`/` 등이 섞이면 fail-closed throw
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
      await atomicWrite(
        approvalFile(req.id),
        renderApprovalBlock(req, tl, new Date(), gateTimeoutMs),
      );
    });

    // 어댑터-로컬 타임아웃 — 무응답 시 해당 요청 파일을 deny 로 종단(게이트도 독립 deny).
    const timer = setTimeout(() => {
      permTimers.delete(req.id);
      void withApprovalsLock(async () => {
        const file = approvalFile(req.id);
        const content = await readMaybe(file);
        if (content === null) return; // 이미 사용자 결정으로 .decided/ 이동됨(handleApprovals)
        const parsed = finalizeApprovalDeny(content, req.id, "timeout");
        if (parsed.changed) await atomicWrite(file, parsed.newContent);
        await moveToDecided(`${req.id}.md`); // 종단(deny) → 아카이브 이관(M6)
      }).catch((err: unknown) =>
        console.error(t("log.markdown.approvalsError", { error: errMsg(err) })),
      );
      for (const cb of decisionHandlers) cb(req.id, "deny");
    }, gateTimeoutMs);
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
