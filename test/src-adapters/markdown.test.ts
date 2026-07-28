import { waitFor } from "../helpers/wait.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseInbox,
  sentLine,
  sendingLine,
  formatStamp,
  stampFromIso,
  isoFromStamp,
  outNoteBase,
  renderApprovalBlock,
  parseApprovals,
  finalizeApprovalDeny,
  isConflictFile,
  createMarkdownSource,
  markdownDescriptor,
  ensureBlankSend,
  blankSendLine,
  matchSentMarker,
  matchSendingMarker,
  isTerminalMarker,
  planArchive,
  archivedLine,
  planRecordsCap,
  emptyLine,
} from "../../src/src-adapters/markdown.js";
import type { Source } from "../../src/src-adapters/source.js";
import type { PermRequest } from "../../src/gate/gate.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { LaneConf } from "../../src/shared/conf.js";

/** 테스트 공용 전송 스탬프 — 형식만 유효하면 값은 임의. */
const STAMP = "20260101-000000";

/** 실시간 폴링 대기 — fs.watch 이벤트 지연 흡수. */

describe("isConflictFile", () => {
  it("Syncthing/Obsidian 충돌 파일명을 판별한다", () => {
    expect(isConflictFile("inbox.sync-conflict-20260628-1.md")).toBe(true);
    expect(isConflictFile("inbox (conflicted copy 2026).md")).toBe(true);
    expect(isConflictFile("note.conflicted.md")).toBe(true);
    expect(isConflictFile("inbox.md")).toBe(false);
    expect(isConflictFile("approvals.md")).toBe(false);
  });
});

describe("parseInbox (actions)", () => {
  it("체크된 send 트리거 직전 세그먼트를 fresh 액션으로 추출한다", () => {
    const r = parseInbox("첫 메시지\n- [x] 📤 send\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "첫 메시지", lineIndex: 1 });
  });

  it("미체크 send 트리거는 액션을 만들지 않는다", () => {
    expect(parseInbox("작성 중\n- [ ] 📤 send\n").actions).toHaveLength(0);
  });

  it("빈 세그먼트의 체크 send 는 empty 액션", () => {
    const r = parseInbox("- [x] 📤 send\n");
    expect(r.actions).toEqual([{ kind: "empty", text: "", lineIndex: 0 }]);
  });

  it("종단(sent) 마커는 경계로 작동한다 — 다중 메시지", () => {
    const content = ["보낸 메시지", sentLine("old", STAMP), "두 번째", "- [x] 📤 send"].join("\n");
    const r = parseInbox(content);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "두 번째" });
  });

  it("종단 마커는 다시 트리거로 인식되지 않는다(멱등)", () => {
    expect(parseInbox("x\n" + sentLine("id-x", STAMP) + "\n").actions).toHaveLength(0);
  });

  it("구버전 sent 마커(`sent <id>`)도 경계로 작동한다(하위호환)", () => {
    expect(parseInbox("x\n- [x] ✅ sent legacy-id\n").actions).toHaveLength(0);
  });

  // A4: 전용 라벨 고정 — 'send' 정확 일치만 트리거
  it("A4: 본문에 send 가 포함된 체크박스는 트리거가 아니다", () => {
    const r = parseInbox("please send the file to me\n- [x] please send the file\n");
    expect(r.actions).toHaveLength(0);
  });

  it("A4: 라벨이 정확히 send 면(이모지 허용) 트리거", () => {
    expect(parseInbox("msg\n- [x] send\n").actions[0]).toMatchObject({ kind: "fresh" });
    expect(parseInbox("msg\n- [x] 🚀 send\n").actions[0]).toMatchObject({ kind: "fresh" });
  });

  it("CRLF(\\r\\n) 저장 노트의 체크된 send 도 트리거로 인식한다", () => {
    const r = parseInbox("메시지\r\n- [x] 📤 send\r\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("메시지");
  });

  it("A4: 트리거가 아닌 사용자 체크박스는 본문에 포함(경계 아님)", () => {
    const r = parseInbox("- [ ] buy milk\n해주세요\n- [x] send\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.text).toContain("buy milk");
    expect(r.actions[0]!.text).toContain("해주세요");
  });

  // A3: sending 마커는 resume 액션
  it("A3: sending 마커는 resume 액션으로 id·스탬프를 보존한다", () => {
    const content = ["재개 메시지", sendingLine("crash-id", STAMP)].join("\n");
    const r = parseInbox(content);
    expect(r.actions).toEqual([
      {
        kind: "resume",
        id: "crash-id",
        stamp: STAMP,
        text: "재개 메시지",
        lineIndex: 1,
        segmentStart: 0,
      },
    ]);
  });

  it("A3: 구버전 sending 마커(스탬프 없음)는 stamp 없이 resume 액션", () => {
    const r = parseInbox("재개\n- [x] ⏳ sending old-id\n");
    expect(r.actions).toEqual([
      { kind: "resume", id: "old-id", text: "재개", lineIndex: 1, segmentStart: 0 },
    ]);
  });

  // M8 2b-2: 아카이브 파싱 — 수동 트리거·strict sent 세그먼트 수집·segmentStart.
  it("fresh 액션은 세그먼트 본문 시작(segmentStart)을 보존한다(전송시점 아카이브용)", () => {
    const r = parseInbox("본문A\n- [x] 📤 send\n");
    expect(r.actions[0]).toMatchObject({ kind: "fresh", lineIndex: 1, segmentStart: 0 });
  });

  it("`🗄️ archive` 체크는 archive 액션(엔진 미경유 로컬 스윕)", () => {
    const r = parseInbox("- [x] 🗄️ archive\n");
    expect(r.actions).toEqual([{ kind: "archive", text: "", lineIndex: 0 }]);
    expect(parseInbox("- [ ] 🗄️ archive\n").actions).toHaveLength(0); // 미체크 → 액션 아님
  });

  it("종단 `archived` 라인은 경계일 뿐 액션·본문이 아니다(재파싱 오염 방지)", () => {
    const r = parseInbox("x\n- [x] 🗄️ archived 3 20260101-000000\n두번째\n- [x] send\n");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "두번째" });
  });

  it("strict sent 마커는 sentSegments 로 수집된다(bodyStart·id·stamp)", () => {
    const content = [
      "본문1",
      sentLine("id-1", STAMP),
      "본문2",
      sentLine("id-2", "20260202-010203"),
    ].join("\n");
    const r = parseInbox(content);
    expect(r.sentSegments).toEqual([
      { markerIndex: 1, bodyStart: 0, id: "id-1", stamp: STAMP },
      { markerIndex: 3, bodyStart: 2, id: "id-2", stamp: "20260202-010203" },
    ]);
  });

  it("레거시 `sent <id>`·수동 `✅ sent`(위키링크 없음)는 sentSegments 비대상(strict)", () => {
    expect(parseInbox("x\n- [x] ✅ sent legacy-id\n").sentSegments).toHaveLength(0);
    expect(parseInbox("x\n- [x] ✅ sent\n").sentSegments).toHaveLength(0);
  });

  // SC-001: 앵커+체크 sending 은 재개 경계로 판별된다.
  it("SC-001: 앵커+체크 sending 은 resume 액션(id·stamp)이 되고 앞 세그먼트가 본문 보존된다", () => {
    const r = parseInbox("중요한 초안\n- [x] ⏳ sending abc 20260708-101010");
    expect(r.actions).toEqual([
      {
        kind: "resume",
        id: "abc",
        stamp: "20260708-101010",
        text: "중요한 초안",
        lineIndex: 1,
        segmentStart: 0,
      },
    ]);
  });

  // SC-002: 미체크 앵커 sending 은 재개 경계가 아니다.
  it("SC-002: 미체크 앵커 sending 은 resume 액션을 만들지 않는다(경계 아님)", () => {
    const r = parseInbox("- [ ] ⏳ sending abc 20260708-101010");
    expect(r.actions).toHaveLength(0);
  });

  // SC-003 (S1): 앵커 없는 "sent …" 접두 사용자 라인은 종단 경계가 아니며 그 앞 메시지가 유실되지 않는다.
  it("SC-003: 앵커 없는 sent 접두 사용자 라인은 경계가 아니라 send 트리거의 fresh 본문에 포함된다", () => {
    const r = parseInbox("안녕하세요 질문이 있습니다\n- [x] sent invoice to client\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("안녕하세요 질문이 있습니다");
    expect(r.actions[0]!.text).toContain("sent invoice to client"); // 경계 아니므로 본문에 그대로 포함
  });

  // SC-004: 앵커를 가진 종단 마커(strict)는 세그먼트 경계로 판별되고 아카이브 수집 대상이 된다.
  it("SC-004: 앵커 종단 마커는 세그먼트 경계로 처리되고 strict 형식은 sentSegments 로 수집된다", () => {
    const r = parseInbox("이전 메시지 본문\n- [x] ✅ sent [[20260708-101010 abc]]");
    expect(r.actions).toHaveLength(0); // 종단 마커 자체는 액션이 아니라 경계
    expect(r.sentSegments).toEqual([
      { markerIndex: 1, bodyStart: 0, id: "abc", stamp: "20260708-101010" },
    ]);
  });

  // SC-005 (S2, 체크·미체크 공통): 앵커 없는 "sending …" 사용자 라인은 재개를 발동하지 않고 원문이 파괴되지 않는다.
  it("SC-005: 앵커 없는 sending 접두 라인(체크)은 재개를 발동하지 않고 원문이 본문으로 보존된다", () => {
    const r = parseInbox("중요한 초안\n- [x] sending report to boss\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("중요한 초안");
    expect(r.actions[0]!.text).toContain("sending report to boss"); // 줄 덮어쓰기 없음(원문 그대로)
  });

  it("SC-005: 앵커 없는 sending 접두 라인(미체크)도 재개를 발동하지 않는다", () => {
    const r = parseInbox("- [ ] sending 내일 리포트\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("sending 내일 리포트");
  });

  // SC-006 (S3): 경계 단어를 접두로 갖는 일상 to-do 는 경계로 오인되지 않는다.
  it("SC-006: `sentiment …` 라인은 sent 종단으로 오인되지 않고 본문으로 취급된다", () => {
    const r = parseInbox("- [x] sentiment analysis done\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("sentiment analysis done");
  });

  it("SC-006: `sending list ready` 라인(앵커 없음)은 재개로 오인되지 않고 본문으로 취급된다", () => {
    const r = parseInbox("- [ ] sending list ready\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh" });
    expect(r.actions[0]!.text).toContain("sending list ready");
  });

  // SC-007: 스탬프가 없는 레거시 in-flight sending 앵커 마커는 계속 재개로 인식된다(회귀 없음).
  it("SC-007: 레거시 sending 앵커(스탬프 없음)는 stamp 없이 resume 액션이 된다", () => {
    const r = parseInbox("초안 본문\n- [x] ⏳ sending old-id");
    expect(r.actions).toEqual([
      { kind: "resume", id: "old-id", text: "초안 본문", lineIndex: 1, segmentStart: 0 },
    ]);
  });

  // SC-008: 위키링크가 없는 레거시/수동 `✅ sent` 앵커 마커는 종단 경계로 유지되되 아카이브 수집 대상에서는 제외된다.
  it("SC-008: 위키링크 없는 수동 `✅ sent` 는 경계로 유지되나 sentSegments 로 수집되지 않는다", () => {
    const r = parseInbox("이전\n- [x] ✅ sent\n두번째\n- [x] 📤 send");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "두번째" }); // 경계 이후로 세그먼트 분리
    expect(r.sentSegments).toHaveLength(0); // strict 형식 아니므로 아카이브 수집 대상 아님
  });

  // SC-009: 엄격 `✅ sent [[stamp id]]` 아카이브 수집이 앵커화 이후에도 회귀 없이 유지된다.
  // 기존 send/archive/제어/크래시-재개 스위트(라인 61~159·599~645·1031~1048) 전건 통과는 5b 실행 시 검증.
  it("SC-009: 앵커화 이후에도 strict sent 마커는 sentSegments 로 계속 수집된다", () => {
    const content = ["본문1", sentLine("id-1", STAMP), "본문2", sentLine("id-2", STAMP)].join("\n");
    const r = parseInbox(content);
    expect(r.sentSegments).toHaveLength(2);
    expect(r.sentSegments[0]).toMatchObject({ id: "id-1", stamp: STAMP });
    expect(r.sentSegments[1]).toMatchObject({ id: "id-2", stamp: STAMP });
  });
});

describe("마커 앵커 판별 헬퍼 — matchSendingMarker/isTerminalMarker (SC-001/002/006/007/008)", () => {
  it("SC-001: 앵커+체크 sending 라인은 id·stamp 를 반환한다", () => {
    expect(matchSendingMarker("- [x] ⏳ sending abc 20260708-101010")).toEqual({
      id: "abc",
      stamp: "20260708-101010",
    });
  });

  it("SC-002: 미체크 앵커 sending 라인은 null(경계 아님)", () => {
    expect(matchSendingMarker("- [ ] ⏳ sending abc 20260708-101010")).toBeNull();
  });

  it("SC-006: 앵커 없는 sending 라인·word-boundary 실패 sent 라인은 판별되지 않는다(lookalike 거부)", () => {
    expect(matchSendingMarker("- [ ] sending list ready")).toBeNull();
    expect(isTerminalMarker("- [x] sentiment analysis done")).toBe(false);
  });

  it("SC-007: 스탬프 없는 레거시 sending 앵커는 stamp 없이 id 만 반환한다", () => {
    expect(matchSendingMarker("- [x] ⏳ sending old-id")).toEqual({ id: "old-id" });
  });

  it("SC-004/SC-008: 종단 앵커는 tail(위키링크) 유무·checked 무관하게 true 를 반환한다", () => {
    expect(isTerminalMarker("- [x] ✅ sent [[20260708-101010 abc]]")).toBe(true);
    expect(isTerminalMarker("- [x] ✅ sent")).toBe(true); // 위키링크 없어도 경계(SC-008)
    expect(isTerminalMarker("- [ ] ✅ sent")).toBe(true); // checked-agnostic(ADR-003)
    expect(isTerminalMarker("- [x] ⚠️ empty (no message)")).toBe(true);
    expect(isTerminalMarker("- [x] 🗄️ archived 3 20260101-000000")).toBe(true);
  });

  it("SC-003/SC-005: 앵커 없는 sent/sending 접두 라인은 종단·재개 어느 쪽으로도 판별되지 않는다", () => {
    expect(isTerminalMarker("- [x] sent invoice to client")).toBe(false);
    expect(matchSendingMarker("- [x] sending report to boss")).toBeNull();
    expect(matchSendingMarker("- [ ] sending 내일 리포트")).toBeNull();
  });
});

describe("아카이브 헬퍼 (M8 2b-2 sent 세그먼트 이관)", () => {
  it("matchSentMarker 는 strict `✅ sent [[stamp id]]` 만 매칭(CRLF 관용)", () => {
    expect(matchSentMarker(sentLine("id-1", STAMP))).toEqual({ stamp: STAMP, id: "id-1" });
    expect(matchSentMarker(sentLine("id-1", STAMP) + "\r")).toEqual({ stamp: STAMP, id: "id-1" });
    expect(matchSentMarker("- [x] ✅ sent legacy-id")).toBeNull(); // 레거시
    expect(matchSentMarker("- [x] ✅ sent")).toBeNull(); // 위키링크 없음
    expect(matchSentMarker("- [ ] 📤 send")).toBeNull();
  });

  it("archivedLine 은 자동 ON 시 · auto 부기", () => {
    expect(archivedLine(2, STAMP, false)).toBe(`- [x] 🗄️ archived 2 ${STAMP}`);
    expect(archivedLine(2, STAMP, true)).toBe(`- [x] 🗄️ archived 2 ${STAMP} · auto`);
  });

  it("planArchive 는 본문을 문서순 append 텍스트+제거범위로 계획, 빈 본문은 멱등 skip", () => {
    const lines = [
      "본문1",
      sentLine("id-1", STAMP),
      sentLine("id-2", STAMP),
      "본문3",
      sentLine("id-3", STAMP),
    ];
    // id-1: body [0,1)="본문1"; id-2: body [2,2)=빈(직전 마커 바로 뒤) → skip; id-3: body [3,4)="본문3".
    const targets = [
      { markerIndex: 1, bodyStart: 0, id: "id-1", stamp: STAMP },
      { markerIndex: 2, bodyStart: 2, id: "id-2", stamp: STAMP },
      { markerIndex: 4, bodyStart: 3, id: "id-3", stamp: STAMP },
    ];
    const { text, ranges } = planArchive(lines, targets);
    expect(ranges).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(text).toContain(`## [[${outNoteBase(STAMP, "id-1")}]]`);
    expect(text).toContain("본문1");
    expect(text).toContain("본문3");
    expect(text).not.toContain("id-2"); // 빈 본문 skip
  });
});

describe("ensureBlankSend (M8 상시 빈 send)", () => {
  it("미체크 빈 send 가 없으면 최상단에 compose 빈 줄 + send 를 추가하고 true 를 반환한다 (방안2)", () => {
    const lines = ["보낸 메시지", sentLine("id-1", STAMP)];
    expect(ensureBlankSend(lines)).toBe(true);
    expect(lines[0]).toBe(""); // compose 빈 줄(입력 자리 — 위-읽기 프롬프트 세그먼트)
    expect(lines[1]).toBe(blankSendLine()); // send 는 그 바로 아래(최상단 활성 트리거)
    expect(blankSendLine()).toBe("- [ ] 📤 send");
    // 기록은 send 아래로(reverse-chrono), send 바로 아래엔 빈 줄 없음(오입력 방지).
    expect(lines[2]).toBe("보낸 메시지");
    expect(lines[3]).toBe(sentLine("id-1", STAMP));
  });

  it("이미 미체크 빈 send 가 있으면 무변경·false (중복 방지)", () => {
    const lines = ["초안", "- [ ] send"];
    const before = [...lines];
    expect(ensureBlankSend(lines)).toBe(false);
    expect(lines).toEqual(before);
  });

  it("이모지-접두 미체크 send 도 기존 트리거로 인식해 중복 추가하지 않는다", () => {
    expect(ensureBlankSend(["- [ ] 📤 send"])).toBe(false);
    expect(ensureBlankSend(["- [ ] 🚀 send"])).toBe(false);
  });

  it("send 가 아닌 미체크 체크박스는 트리거로 세지 않는다 (초안 to-do 오인 금지)", () => {
    const lines = ["- [ ] buy milk", "- [ ] send now"]; // 정확 일치 아님
    expect(ensureBlankSend(lines)).toBe(true);
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe(blankSendLine());
  });

  it("체크된 send(대소문자 [x]/[X] = 소모)만 있으면 새 빈 send 를 추가한다", () => {
    const lower = ["보낼 것", "- [x] send"];
    expect(ensureBlankSend(lower)).toBe(true);
    expect(lower.filter((l) => l === blankSendLine())).toHaveLength(1);
    const upper = ["보낼 것", "- [X] send"];
    expect(ensureBlankSend(upper)).toBe(true);
    expect(upper.filter((l) => l === blankSendLine())).toHaveLength(1);
  });

  it("CRLF(\\r) 미체크 send 도 기존 트리거로 인식한다 (중복 추가 없음)", () => {
    expect(ensureBlankSend(["- [ ] send\r"])).toBe(false);
  });

  it("선행 빈 줄이 여러 개여도 정규화해 compose 한 줄만 남긴다 (방안2 — leading blank 누적 방지)", () => {
    const lines = ["", "", "지난 기록", sentLine("id-1", STAMP)];
    expect(ensureBlankSend(lines)).toBe(true);
    expect(lines[0]).toBe(""); // compose 하나
    expect(lines[1]).toBe(blankSendLine());
    expect(lines[2]).toBe("지난 기록"); // 선행 빈 줄들은 제거됨
    expect(lines.filter((l) => l === "")).toHaveLength(1);
  });

  it("추가된 빈 send 는 미체크라 parseInbox 액션이 되지 않는다 (오전송 없음)", () => {
    const lines = [sentLine("id-1", STAMP)];
    ensureBlankSend(lines);
    expect(parseInbox(lines.join("\n")).actions).toHaveLength(0);
  });
});

describe("세션 제어 라벨 파싱", () => {
  it("체크된 clear/compact 는 control 액션(정확 일치·이모지 허용)", () => {
    expect(parseInbox("- [x] 🧹 clear\n").actions).toEqual([
      { kind: "control", controlKind: "clear", text: "", lineIndex: 0 },
    ]);
    expect(parseInbox("- [x] compact\n").actions).toEqual([
      { kind: "control", controlKind: "compact", text: "", lineIndex: 0 },
    ]);
  });

  it("미체크 제어 라벨은 액션 없음(경계만)", () => {
    expect(parseInbox("- [ ] clear\n").actions).toHaveLength(0);
  });

  it("resume 무인자 = 목록(sessions), 인자 = resume", () => {
    expect(parseInbox("- [x] resume\n").actions[0]).toMatchObject({
      kind: "control",
      controlKind: "sessions",
    });
    expect(parseInbox("- [x] ⏪ resume 2\n").actions[0]).toMatchObject({
      kind: "control",
      controlKind: "resume",
      controlArg: "2",
    });
  });

  it("resume 세션 id 인자는 대소문자를 보존한다(라벨 소문자화에 삼켜지지 않음)", () => {
    expect(parseInbox("- [x] resume ABC-Xyz_9\n").actions[0]).toMatchObject({
      kind: "control",
      controlKind: "resume",
      controlArg: "ABC-Xyz_9",
    });
  });

  it("본문에 clear 가 포함된 라벨은 제어가 아니다(부분일치 금지)", () => {
    expect(parseInbox("- [x] clear the build dir\n").actions).toHaveLength(0);
  });

  it("제어 라벨은 경계 — 위 텍스트는 다음 send 세그먼트에 포함되지 않는다", () => {
    const r = parseInbox("작성 중 초안\n- [x] clear\n다음 메시지\n- [x] send\n");
    const fresh = r.actions.find((a) => a.kind === "fresh");
    expect(fresh?.text).toBe("다음 메시지");
  });
});

describe("전송 스탬프", () => {
  it("formatStamp 은 로컬 시각을 YYYYMMDD-HHmmss 로 표기한다", () => {
    expect(formatStamp(new Date(2026, 6, 3, 16, 20, 45))).toBe("20260703-162045");
  });

  it("isoFromStamp 는 스탬프를 ISO 로 복원한다(roundtrip)", () => {
    const iso = isoFromStamp("20260703-162045");
    expect(iso).not.toBeNull();
    expect(stampFromIso(iso!)).toBe("20260703-162045");
  });

  it("isoFromStamp 는 형식 불일치에 null", () => {
    expect(isoFromStamp("not-a-stamp")).toBeNull();
    expect(isoFromStamp("2026-07-03")).toBeNull();
  });

  it("sent 라인은 out 노트 basename 위키링크를 담는다", () => {
    expect(sentLine("id-1", "20260703-162045")).toBe("- [x] ✅ sent [[20260703-162045 id-1]]");
    expect(outNoteBase("20260703-162045", "id-1")).toBe("20260703-162045 id-1");
  });
});

describe("approvals 파싱", () => {
  const req: PermRequest = {
    v: 1,
    id: "req-1",
    lane: "L",
    channel: "markdown",
    tool: "Bash",
    detail: "rm -rf build/",
    cwd: "/proj",
    ts: "2026-06-28T00:00:00Z",
  };

  it("renderApprovalBlock 은 pending 마커와 allow/deny 박스를 포함한다", () => {
    const block = renderApprovalBlock(req);
    expect(block).toContain("status=pending");
    expect(block).toContain("id=req-1");
    expect(block).toContain("- [ ] allow");
    expect(block).toContain("- [ ] deny");
  });

  it("renderApprovalBlock 은 요청 시각·자동 거부 기한을 표기한다", () => {
    const now = new Date(2026, 6, 3, 16, 20, 45);
    const block = renderApprovalBlock(req, undefined, now);
    expect(block).toContain("20260703-162045"); // 요청 시각 스탬프
    expect(block).toContain("자동 거부"); // 기한 안내(테스트 로케일 ko)
  });

  it("renderApprovalBlock 기한은 주입된 timeoutMs 를 반영한다 (F12a 옵트인 타임아웃)", () => {
    const now = new Date(2026, 6, 3, 16, 20, 45);
    // 기본(600s) 기한이 아니라 60s 후(16:21:45)로 표기되어야 한다.
    const block = renderApprovalBlock(req, undefined, now, 60_000);
    expect(block).toContain("20260703-162145");
  });

  it("allow 단일 체크 → allow 결정 + 마커 종단 재작성", () => {
    const content = renderApprovalBlock(req).replace("- [ ] allow", "- [x] allow");
    const r = parseApprovals(content);
    expect(r.decisions).toEqual([{ reqId: "req-1", decision: "allow" }]);
    expect(r.newContent).toContain("status=allow");
    expect(r.newContent).not.toContain("status=pending");
  });

  it("deny 단일 체크 → deny 결정", () => {
    const content = renderApprovalBlock(req).replace("- [ ] deny", "- [x] deny");
    const r = parseApprovals(content);
    expect(r.decisions).toEqual([{ reqId: "req-1", decision: "deny" }]);
  });

  it("양쪽 체크 = 모호 → 결정 없음(pending 유지)", () => {
    const content = renderApprovalBlock(req)
      .replace("- [ ] allow", "- [x] allow")
      .replace("- [ ] deny", "- [x] deny");
    const r = parseApprovals(content);
    expect(r.decisions).toHaveLength(0);
    expect(r.changed).toBe(false);
  });

  it("무체크 → 결정 없음", () => {
    const r = parseApprovals(renderApprovalBlock(req));
    expect(r.decisions).toHaveLength(0);
  });

  it("종단된 블록은 재처리하지 않는다(멱등)", () => {
    const resolved = renderApprovalBlock(req).replace("status=pending", "status=allow");
    const withCheck = resolved.replace("- [ ] allow", "- [x] allow");
    const r = parseApprovals(withCheck);
    expect(r.decisions).toHaveLength(0);
  });

  it("finalizeApprovalDeny 는 pending 을 deny(timeout) 로 종단한다", () => {
    const r = finalizeApprovalDeny(renderApprovalBlock(req), "req-1", "timeout");
    expect(r.changed).toBe(true);
    expect(r.newContent).toContain("status=deny");
    expect(r.newContent).toContain("reason=timeout");
  });

  it("finalizeApprovalDeny 는 가시 헤딩도 ⛔·req(deny) 로 갱신한다(⏳ pending 잔존 방지)", () => {
    const r = finalizeApprovalDeny(renderApprovalBlock(req), "req-1", "timeout");
    expect(r.newContent).toContain("### ⛔");
    expect(r.newContent).toContain("req(deny)");
    // ⏳ pending 헤딩 마커가 화면에 남지 않는다.
    expect(r.newContent).not.toContain("### ⏳");
  });
});

describe("createMarkdownSource (통합)", () => {
  let tmpBase: string;
  let rootDir: string;
  let paths: ReturnType<typeof lanePaths>;
  let conf: LaneConf;
  let source: Source | null = null;

  function makeSource(): Source {
    return createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
  }

  /** queueDir 부재 시 0 — readdirSync ENOENT 회피. */
  function msgCount(): number {
    if (!fs.existsSync(paths.queueDir)) return 0;
    return fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length;
  }

  /** 오늘(로컬) 날짜 폴더명 — moveToDecided/아카이브(결정·기록 시점 로컬일 파생, FR-002·FR-003) 검증용. */
  function todayDateStr(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 전송 스탬프(YYYYMMDD-HHmmss)에서 날짜 폴더명(YYYY-MM-DD) 파생 — renderOut 파티션 검증용(FR-001). */
  function dateFolderFromStamp(stamp: string): string {
    return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  }

  /**
   * out-ledger entry 직접 기록 — renderOut 픽스처용(013-out-state-ledger 이전).
   * setDone 은 전이 시각(now)을 ts 로 고정하므로, 결정적 과거 ts/origin_ts 를 검증하려면
   * ledger.json 을 직접 기록한다(out-ledger.test.ts 의 writeLedgerFixture 와 동일 관례).
   */
  function writeLedgerEntry(
    id: string,
    entry: {
      reply_ref?: { channel_msg_id: string };
      ts?: string;
      origin_ts?: string;
      question?: string;
    },
  ): void {
    const ledgerPath = paths.outLedgerFile;
    let ledger: { v: number; entries: Record<string, unknown> } = { v: 1, entries: {} };
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as typeof ledger;
    }
    ledger.entries[id] = { state: "done", ...entry };
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  }

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-markdown-"));
    rootDir = path.join(tmpBase, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    paths = lanePaths(tmpBase, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    conf = {
      source: "markdown",
      backend: "acp",
      engine: "claude",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: [],
      hard_deny: [],
      auto_relaunch: true,
      markdown: { root: rootDir, inbox: "inbox.md" },
    };
  });

  afterEach(() => {
    if (source) source.stop();
    source = null;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("root/inbox conf 누락 시 생성에서 throw (fail-closed)", () => {
    const bad: LaneConf = { ...conf };
    delete bad.markdown;
    expect(() =>
      createMarkdownSource({ lane: "L", proj: "p", engine: "e", paths, conf: bad }),
    ).toThrow();
  });

  it("없는 root 경로로 start 시 throw", async () => {
    conf.markdown!.root = path.join(tmpBase, "NoSuchRoot");
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  it("inbox 상대경로에 '..' 면 start 시 throw (root 탈출 방지, 011-C)", async () => {
    conf.markdown!.inbox = "../escape.md";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  it("outbox 절대경로면 start 시 throw (011-C)", async () => {
    conf.markdown!.outbox = path.join(tmpBase, "evil");
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  // A1: 제어 노트가 AI 작업폴더(cwd) 내부면 fail-closed 기동 거부
  it("A1: inbox 가 cwd 내부면 start 거부(자기승인 방지)", async () => {
    conf.cwd = rootDir; // 작업폴더 = 노트 루트 → inbox 가 cwd 내부
    source = makeSource();
    await expect(source!.start()).rejects.toThrow(/자기승인|cwd/);
  });

  it("A1: 제어 노트가 cwd 밖이면 정상 기동", async () => {
    conf.cwd = path.join(tmpBase, "project"); // 노트 루트와 분리
    fs.mkdirSync(conf.cwd, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();
  });

  it("상호 배타(006): approvals 와 outbox 가 같은 경로면 start 거부", async () => {
    conf.markdown!.approvals = "shared";
    conf.markdown!.outbox = "shared";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow(/포함 관계|분리/);
  });

  it("상호 배타(006): inbox 노트가 outbox 디렉터리 내부면 start 거부", async () => {
    conf.markdown!.inbox = "out/inbox.md";
    conf.markdown!.outbox = "out";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow(/겹칩니다|분리/);
  });

  it.runIf(process.platform === "darwin")(
    "상호 배타(006): 대소문자만 다른 경로(macOS 대소문자 무시 FS)도 start 거부",
    async () => {
      conf.markdown!.approvals = "Shared";
      conf.markdown!.outbox = "shared";
      source = makeSource();
      await expect(source!.start()).rejects.toThrow(/포함 관계|분리/);
    },
  );

  it("상호 배타(006): approvals 를 격리 디렉터리(.conflicts)와 겹치게 두면 start 거부", async () => {
    conf.markdown!.approvals = ".conflicts";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow(/포함 관계|분리/);
  });

  it("인박스의 체크된 send 블록을 envelope 으로 큐잉하고 sent 로 종단한다", async () => {
    // 007 존 레이아웃 기본 켜짐(markdown.layout 기본 on)으로 최상단·기록 존 구조가 바뀌므로
    // 이 테스트가 고정하는 레거시(위-읽기 제자리 종단) 계약은 layout=off 로 pin 한다(T-D3).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "마크다운 노트에서 보낸 지시\n- [x] 📤 send\n");

    source = makeSource();
    await source.start(); // 기동 시 초기 1회 처리

    await waitFor(() => msgCount() >= 1);

    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["source"]).toBe("markdown");
    expect(env["text"]).toBe("마크다운 노트에서 보낸 지시");
    expect(env["lane"]).toBe("L");

    // 인박스가 sent 종단으로 재작성됨
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes("sent"));

    // M8+방안2: 소모된 send 를 대체할 빈 send 가 정확히 하나, 문서 최상단(compose 빈 줄 아래)에 준비된다.
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(blankSendLine()));
    const finalInbox = fs.readFileSync(inboxPath, "utf8");
    const finalLines = finalInbox.split("\n");
    const blanks = finalLines.filter((l) => l === blankSendLine());
    expect(blanks).toHaveLength(1);
    // 방안2: 최상단 = compose 빈 줄 + send, 기록(sent)은 그 아래로(reverse-chrono).
    expect(finalLines[0]).toBe(""); // compose 빈 줄(입력 자리)
    expect(finalLines[1]).toBe(blankSendLine()); // 활성 send 는 최상단
    expect(finalLines[2]).not.toBe(""); // send 바로 아래엔 빈 줄 없음(아래는 기록)
    expect(finalInbox).toContain("✅ sent"); // 소비된 메시지는 send 아래에 sent 로 종단
    // 개행 위생: 트레일링 개행 누적 없음.
    expect(finalInbox.endsWith("\n\n")).toBe(false);

    // 자기쓰기 가드: 종단 후 추가 enqueue 없음(빈 send 추가는 미체크라 재트리거 안 됨)
    await new Promise((r) => setTimeout(r, 200));
    expect(msgCount()).toBe(1);
  });

  it("M8: 미체크 send 가 없는 inbox(재기동·삭제)면 빈 send 를 self-heal 한다 (액션 없음)", async () => {
    // 007: layout=on(기본)이면 self-heal 이 healLayout(3존 정규화)로 대체되어 이 테스트가
    // 고정하는 ensureBlankSend 전용 레거시 계약과 달라진다 → layout=off pin(T-D3).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    // sent 종단만 있고 사용 가능한 미체크 send 가 없는 상태(예: 재기동 후).
    fs.writeFileSync(inboxPath, "지난 메시지\n" + sentLine("old-id", STAMP) + "\n");

    source = makeSource();
    await source.start();

    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(blankSendLine()));
    // 액션이 아니므로 큐잉 없음(빈 send 만 추가).
    expect(msgCount()).toBe(0);
    // 멱등: 이후 스캔이 두 번째 빈 send 를 추가하지 않는다.
    await new Promise((r) => setTimeout(r, 200));
    const blanks = fs
      .readFileSync(inboxPath, "utf8")
      .split("\n")
      .filter((l) => l === blankSendLine());
    expect(blanks).toHaveLength(1);
  });

  it("M8: 미체크 빈 send 만 있는 inbox 는 전송하지 않고 유지한다 (오전송 없음)", async () => {
    // 007: layout=on 기본이면 self-heal 이 팔레트·센티널·기록 존까지 재구성해 이 테스트의
    // "정확히 그 2줄만" 전제가 깨진다 → layout=off pin(T-D3, 레거시 계약 보존).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, blankSendLine() + "\n");

    source = makeSource();
    await source.start();

    await new Promise((r) => setTimeout(r, 200));
    expect(msgCount()).toBe(0); // 미체크 → 액션 없음 → enqueue 없음
    const blanks = fs
      .readFileSync(inboxPath, "utf8")
      .split("\n")
      .filter((l) => l === blankSendLine());
    expect(blanks).toHaveLength(1); // 이미 있으므로 추가도 없음
  });

  // FR-12: enqueue 연속 실패 임계 도달 시 outbox 알림 노트 1회
  it("enqueue 연속 실패가 임계에 도달하면 outbox 에 알림 노트를 1회 기록한다 (FR-12)", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    // 3개 send 블록 — 한 처리 패스에서 enqueue 가 3회 연속 실패하도록.
    fs.writeFileSync(
      inboxPath,
      "메시지1\n- [x] 📤 send\n메시지2\n- [x] 📤 send\n메시지3\n- [x] 📤 send\n",
    );
    // enqueue 실패 강제: queueDir 경로에 (디렉터리 대신) 파일을 둬 mkdir(recursive) 가 실패하게 한다.
    fs.mkdirSync(path.dirname(paths.queueDir), { recursive: true });
    fs.writeFileSync(paths.queueDir, "block");

    source = makeSource();
    await source.start();

    const alertPath = path.join(rootDir, "out", "_enqueue-alert.md");
    await waitFor(() => fs.existsSync(alertPath));
    expect(fs.readFileSync(alertPath, "utf8")).toContain("enqueue");
    // finding3(enqueue 전량 실패 경로): finalize 없음에도 빈 send 는 보장된다(else-if 분기).
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(blankSendLine()));
  });

  // A3: 크래시(enqueue 전 sending 마킹만 남음) → 재기동 시 정확히 1회 enqueue
  it("A3: sending 마커가 큐에 없으면 재기동 시 재enqueue 후 sent 종단", async () => {
    // 007: layout=on 기본이면 sent 종단이 기록 존으로 이동해 정확 문자열 위치 전제(제자리
    // 종단)가 달라진다 → layout=off pin(T-D3). layout-on 크래시 재개는 SC-017 신규 테스트가 커버.
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    // 크래시 시뮬레이션: sending <id> <stamp> 만 남고 enqueue 는 안 된 상태
    fs.writeFileSync(inboxPath, `복구될 메시지\n${sendingLine("crash-1", STAMP)}\n`);

    source = makeSource();
    await source.start();

    await waitFor(() => msgCount() >= 1);
    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(files.some((f) => f.includes("crash-1"))).toBe(true);
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["id"]).toBe("crash-1");
    expect(env["text"]).toBe("복구될 메시지");
    // 재개 envelope.ts 는 sending 라인의 스탬프를 재현한다(sent 링크·노트 파일명 일치).
    expect(stampFromIso(env["ts"] as string)).toBe(STAMP);

    // sent 종단은 스탬프+id 위키링크
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(`sent [[${STAMP} crash-1]]`));
    // 중복 없음
    await new Promise((r) => setTimeout(r, 150));
    expect(msgCount()).toBe(1);
    // finding3(resume 경로): 종단과 함께 빈 send 가 정확히 하나 준비된다(Phase B 통합).
    const blanks = fs
      .readFileSync(inboxPath, "utf8")
      .split("\n")
      .filter((l) => l === blankSendLine());
    expect(blanks).toHaveLength(1);
  });

  // A3: 이미 처리된 sending(out 존재) → 재enqueue 없이 종단만
  it("A3: sending 마커의 id 가 이미 out 에 있으면 재enqueue 하지 않는다", async () => {
    // 007: layout=on 기본이면 sent 종단이 기록 존으로 이동한다 → 레거시 제자리 종단 계약은
    // layout=off pin 으로 보존한다(T-D3).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, `이미 처리됨\n${sendingLine("done-1", STAMP)}\n`);
    // out/<id>.out 존재 = 이미 완료된 메시지
    fs.writeFileSync(path.join(paths.outDir, "done-1.out"), "응답");

    source = makeSource();
    await source.start();

    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(`sent [[${STAMP} done-1]]`));
    expect(msgCount()).toBe(0); // 큐에 재enqueue 되지 않음
  });

  // fs.watch 누락 시 2s 폴링 백스톱에 의존하는 경로 — 풀 스위트 병렬 부하에서 격리가
  // 수 초 지연될 수 있어 테스트·대기 시한을 함께 상향(기본 8s 대기로는 간헐 초과).
  it("동기 충돌 파일은 격리되고 큐잉되지 않는다", { timeout: 15_000 }, async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "정상\n");
    source = makeSource();
    await source.start();

    // start 이후 충돌 파일 생성 → watch 가 격리
    const conflict = path.join(rootDir, "inbox.sync-conflict-20260628-abc.md");
    fs.writeFileSync(conflict, "악성 트리거\n- [x] 📤 send\n");

    await waitFor(
      () => fs.existsSync(path.join(rootDir, ".conflicts", "inbox.sync-conflict-20260628-abc.md")),
      { timeoutMs: 12_000 },
    );
    expect(msgCount()).toBe(0);
  });

  it("권한 요청 → 요청당 approvals 파일 기록 → allow 체크 감지 → onDecision(allow) (011-D)", async () => {
    // 요청당 파일(D): approvals/<req-id>.md (기본 approvalsDir = inbox 형제 approvals/).
    const reqFile = path.join(rootDir, "approvals", "req-allow.md");
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    const decisions: string[] = [];
    source.onDecision((reqId, decision) => decisions.push(`${reqId}:${decision}`));

    const req: PermRequest = {
      v: 1,
      id: "req-allow",
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    };
    await source.requestPermission(req);

    await waitFor(
      () => fs.existsSync(reqFile) && fs.readFileSync(reqFile, "utf8").includes("req-allow"),
    );

    // 사용자가 allow 체크
    const cur = fs.readFileSync(reqFile, "utf8");
    fs.writeFileSync(reqFile, cur.replace("- [ ] allow", "- [x] allow"));

    await waitFor(() => decisions.includes("req-allow:allow"));
    expect(decisions).toContain("req-allow:allow");

    // 종단(allow)된 파일은 .decided/<날짜>/ 로 이관되고 top-level 에선 사라진다(M6 — pending 만
    // 스캔, FR-002 결정 시점 날짜 파티셔닝).
    const decidedFile = path.join(rootDir, "approvals", ".decided", todayDateStr(), "req-allow.md");
    await waitFor(() => fs.existsSync(decidedFile));
    expect(fs.readFileSync(decidedFile, "utf8")).toContain("status=allow");
    expect(fs.existsSync(reqFile)).toBe(false);
  });

  it("deny 체크 종단분도 .decided/ 로 이관된다 (M6)", async () => {
    const reqFile = path.join(rootDir, "approvals", "req-deny.md");
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();
    const decisions: string[] = [];
    source.onDecision((reqId, decision) => decisions.push(`${reqId}:${decision}`));

    const req: PermRequest = {
      v: 1,
      id: "req-deny",
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    };
    await source.requestPermission(req);
    await waitFor(
      () => fs.existsSync(reqFile) && fs.readFileSync(reqFile, "utf8").includes("req-deny"),
    );
    const cur = fs.readFileSync(reqFile, "utf8");
    fs.writeFileSync(reqFile, cur.replace("- [ ] deny", "- [x] deny"));

    await waitFor(() => decisions.includes("req-deny:deny"));
    const decidedFile = path.join(rootDir, "approvals", ".decided", todayDateStr(), "req-deny.md");
    await waitFor(() => fs.existsSync(decidedFile));
    expect(fs.readFileSync(decidedFile, "utf8")).toContain("status=deny");
    expect(fs.existsSync(reqFile)).toBe(false);
  });

  it("pending 은 top-level 유지, 종단 잔존분은 스캔서 .decided/ 로 이관 (M6 게이트 무결성·재기동 멱등)", async () => {
    const approvals = path.join(rootDir, "approvals");
    fs.mkdirSync(approvals, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    const mkReq = (id: string): PermRequest => ({
      v: 1,
      id,
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    });
    // 종단(allow) 잔존 파일 — 크래시로 이동 못한 상태 모사(marker 만 종단, 결정 콜백 없음).
    const terminal = renderApprovalBlock(mkReq("req-term")).replace(
      "status=pending",
      "status=allow",
    );
    fs.writeFileSync(path.join(approvals, "req-term.md"), terminal);
    // pending 파일 — 사용자 미결정(절대 이동 금지).
    fs.writeFileSync(path.join(approvals, "req-pend.md"), renderApprovalBlock(mkReq("req-pend")));

    source = makeSource();
    await source.start();

    const decidedDate = todayDateStr();
    await waitFor(() =>
      fs.existsSync(path.join(approvals, ".decided", decidedDate, "req-term.md")),
    );
    expect(fs.existsSync(path.join(approvals, "req-term.md"))).toBe(false); // 종단분 이동됨
    expect(fs.existsSync(path.join(approvals, "req-pend.md"))).toBe(true); // pending 유지(무결성)
    expect(fs.existsSync(path.join(approvals, ".decided", decidedDate, "req-pend.md"))).toBe(false);
  });

  it("경로 탈출 req.id 는 fail-closed throw — approvals 밖 쓰기 차단(방어심화)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    const evil: PermRequest = {
      v: 1,
      id: "../../evil",
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    };
    // 게이트가 sendPermPrompt(=requestPermission) throw 를 deny 로 처리하므로 throw 가 곧 fail-closed.
    await expect(source.requestPermission(evil)).rejects.toThrow();
    // approvals 디렉터리 밖(rootDir 상위)에 evil.md 가 생기지 않아야 한다.
    expect(fs.existsSync(path.join(rootDir, "..", "evil.md"))).toBe(false);
  });

  it("동시 다중 권한 요청은 요청당 별도 파일로 격리된다 (011-D)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    const mk = (id: string): PermRequest => ({
      v: 1,
      id,
      lane: "L",
      channel: "markdown",
      tool: "Bash",
      detail: "ls",
      cwd: "/proj",
      ts: "2026-06-28T00:00:00Z",
    });
    await source.requestPermission(mk("req-a"));
    await source.requestPermission(mk("req-b"));

    const fileA = path.join(rootDir, "approvals", "req-a.md");
    const fileB = path.join(rootDir, "approvals", "req-b.md");
    await waitFor(() => fs.existsSync(fileA) && fs.existsSync(fileB));
    expect(fs.readFileSync(fileA, "utf8")).toContain("req-a");
    expect(fs.readFileSync(fileB, "utf8")).toContain("req-b");

    // req-a 만 allow 체크 → req-a 만 결정, req-b 는 pending 유지(격리)
    const decisions: string[] = [];
    source.onDecision((reqId, decision) => decisions.push(`${reqId}:${decision}`));
    fs.writeFileSync(fileA, fs.readFileSync(fileA, "utf8").replace("- [ ] allow", "- [x] allow"));

    await waitFor(() => decisions.includes("req-a:allow"));
    expect(decisions).toContain("req-a:allow");
    expect(decisions.some((d) => d.startsWith("req-b"))).toBe(false);
    expect(fs.readFileSync(fileB, "utf8")).toContain("status=pending");
  });

  it("renderOut(id) 호출 시 마크다운 출력 노트를 작성한다(reply_ref 는 헤더에 미렌더)", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    // injector 가 writeOutBody+setDone 후 in-process 로 renderOut 호출(out/ watch 제거)
    writeLedgerEntry("msg-1", { reply_ref: { channel_msg_id: "orig-9" } });
    fs.writeFileSync(path.join(paths.outDir, "msg-1.out"), "에이전트 응답입니다");

    await source.renderOut("msg-1");

    // origin_ts 없는 구버전 sidecar → 종전 `<id>.md` 파일명 유지(하위호환)
    const notePath = path.join(rootDir, "out", "msg-1.md");
    expect(fs.existsSync(notePath)).toBe(true);
    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("에이전트 응답입니다");
    // markdown 레인의 channel_msg_id 는 노트 자기 id 라 헤더에 렌더하지 않는다(자기순환 중복).
    expect(note).not.toContain("orig-9");
    expect(note).not.toContain("↩");
  });

  // 007 T-D3(재작성): layout=on 이 기본이므로 제어 라벨은 더는 sent 위키링크로 종단되지 않고
  // FR-001/ADR-007 대로 "실행 → 그 자리 미체크 복원"(팔레트 상주 계약)된다(SC-001/SC-002).
  it("SC-001/제어 라벨(layout-on 기본): clear 체크 → control envelope 큐잉 → 미체크 복원", async () => {
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "- [x] 🧹 clear\n");

    source = makeSource();
    await source.start();

    await waitFor(() => msgCount() >= 1);
    const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as Record<
      string,
      unknown
    >;
    expect(env["control"]).toEqual({ kind: "clear" });
    expect(env["text"]).toBe("/clear");

    // sent 종단이 아니라 그 자리가 다시 미체크로 복원된다 — 팔레트는 소멸하지 않는다.
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes("- [ ] 🧹 clear"));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).not.toMatch(/sent \[\[.+\]\]/);
    // 재발화 없음(자기쓰기 echo 가드) — 1회만 enqueue.
    await new Promise((r) => setTimeout(r, 200));
    expect(msgCount()).toBe(1);
  });

  it("SC-001/제어 라벨(layout-on 기본): resume 번호 라벨은 세션 장부 최신순 해석 후 미체크 복원", async () => {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(
      paths.sessionsFile,
      JSON.stringify([
        {
          id: "sess-new",
          createdAt: "2026-07-03T00:00:00Z",
          lastActivityAt: "2026-07-03T12:00:00Z",
        },
        {
          id: "sess-old",
          createdAt: "2026-07-01T00:00:00Z",
          lastActivityAt: "2026-07-01T12:00:00Z",
        },
      ]),
    );
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "- [x] resume 2\n");

    source = makeSource();
    await source.start();

    await waitFor(() => msgCount() >= 1);
    const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as {
      control?: { kind: string; sessionId?: string };
    };
    expect(env.control).toEqual({ kind: "resume", sessionId: "sess-old" });

    // control 종단은 sent 링크가 아니라 라벨 자리 미체크 복원(ADR-007) — 인자·라벨 보존.
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes("- [ ] resume 2"));
    expect(fs.readFileSync(inboxPath, "utf8")).not.toMatch(/sent \[\[.+\]\]/);
  });

  it("E2E 계약: sent 위키링크 텍스트 == renderOut 노트 파일명 (전 경로 관통)", async () => {
    // 007: 링크 텍스트 계약(outNoteBase) 자체는 zone 이동과 무관하나, 이 테스트가 검증하는
    // 원문 그대로의 위-읽기 구조를 고정하기 위해 layout=off pin(T-D3).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "질문입니다\n- [x] 📤 send\n");

    source = makeSource();
    await source.start();

    // 인박스 처리 → sent 위키링크 확보
    await waitFor(() => /sent \[\[.+\]\]/.test(fs.readFileSync(inboxPath, "utf8")));
    const link = /sent \[\[(.+)\]\]/.exec(fs.readFileSync(inboxPath, "utf8"))![1]!;

    // 큐 envelope 로 injector 의 writeOutBody+setDone 을 재현(origin_ts = envelope.ts)
    const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
    const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as {
      id: string;
      ts: string;
    };
    writeLedgerEntry(env.id, { reply_ref: { channel_msg_id: env.id }, origin_ts: env.ts });
    fs.writeFileSync(path.join(paths.outDir, `${env.id}.out`), "응답");

    await source.renderOut(env.id);

    // 링크 텍스트 그대로가 노트 파일명이어야 링크가 해소된다 — 파일은 stamp 파생 날짜 폴더 아래(FR-001).
    const stamp = link.split(" ")[0]!;
    expect(fs.existsSync(path.join(rootDir, "out", dateFolderFromStamp(stamp), `${link}.md`))).toBe(
      true,
    );
  });

  it("renderOut: origin_ts sidecar → 스탬프 파일명 + 질문·시각 헤더", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    const originIso = isoFromStamp("20260703-162045")!;
    const doneIso = isoFromStamp("20260703-162130")!;
    writeLedgerEntry("msg-2", {
      reply_ref: { channel_msg_id: "msg-2" },
      origin_ts: originIso,
      ts: doneIso,
      question: "빌드 오류 원인 분석해줘",
    });
    fs.writeFileSync(path.join(paths.outDir, "msg-2.out"), "분석 결과입니다");

    await source.renderOut("msg-2");

    // 파일명 = sent 위키링크 텍스트(outNoteBase)와 동일 — 링크 해소 계약. 경로는 stamp 파생
    // 날짜 폴더(2026-07-03) 아래(FR-001·ADR-002).
    const notePath = path.join(
      rootDir,
      "out",
      "2026-07-03",
      `${outNoteBase("20260703-162045", "msg-2")}.md`,
    );
    expect(fs.existsSync(notePath)).toBe(true);
    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("분석 결과입니다");
    expect(note).toContain("> ❓ 빌드 오류 원인 분석해줘");
    expect(note).toContain("20260703-162045"); // 요청 스탬프
    expect(note).toContain("20260703-162130"); // 완료 스탬프
  });

  // ── M8 2b-2: sent 세그먼트 아카이브 이관 ──────────────────────────────────
  // ADR-003: `markdown.archive` 는 파일이 아니라 전용 디렉터리로 해석되고, 그 안에 아카이브
  // 시점 로컬일(YYYY-MM-DD.md) 파일이 생긴다(FR-003). archive 미설정(config off) 시 기본
  // 디렉터리명은 `sent-archive`(A-02 기본값, `.md` 없음) — conf.markdown.archive 지정 시엔
  // 그 값 자체가 디렉터리명이 된다(예: "sent-archive.md" 라는 이름의 디렉터리).
  const archiveDirPath = (): string => path.join(rootDir, conf.markdown?.archive ?? "sent-archive");
  const archiveFilePath = (): string => path.join(archiveDirPath(), `${todayDateStr()}.md`);

  it("자동(config on): 전송 시점에 본문을 아카이브로 이관하고 inbox 엔 sent 마커만 남긴다", async () => {
    // layout=on 기본이면 즉시 아카이브가 markdown.archive 지정과 무관하게 항상 켜지는 동작 변경이
    // 있어, "config on 이 곧 autoArchive 트리거" 라는 이 테스트의 레거시 전제를 layout=off pin 으로
    // 보존한다. layout-on 기본 즉시 아카이브(미지정도 자동·archive=디렉터리 오버라이드)는 별도 신규
    // 테스트가 커버한다.
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "이관될 본문입니다\n- [x] 📤 send\n");

    source = makeSource();
    await source.start();

    await waitFor(() => /sent \[\[.+\]\]/.test(fs.readFileSync(inboxPath, "utf8")));
    await waitFor(() => fs.existsSync(archiveFilePath()));

    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).not.toContain("이관될 본문입니다"); // 본문 제거
    expect(inbox).toMatch(/sent \[\[.+\]\]/); // 마커는 잔존
    expect(inbox.split("\n").filter((l) => l === blankSendLine())).toHaveLength(1);
    expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("이관될 본문입니다"); // 본문은 아카이브에
    expect(msgCount()).toBe(1); // enqueue 는 정상 1회
  });

  it("자동(config on): 조용한 턴(체크 액션 없음)엔 스윕하지 않아 상위 초안이 보존된다(S4·S6)", async () => {
    // 007 T-D3: config-on 이 곧 autoArchive 라는 레거시 전제 보존(layout=off pin) — 위와 동일 근거.
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    // sent 마커 위의 미완성 초안 — 조용한 턴엔 자동 스윕 대상 아님(전송 시점에만 아카이브).
    fs.writeFileSync(inboxPath, "미완성 초안\n" + sentLine("old", STAMP) + "\n- [ ] 📤 send\n");

    source = makeSource();
    await source.start();

    await new Promise((r) => setTimeout(r, 250));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).toContain("미완성 초안"); // 초안 보존
    expect(msgCount()).toBe(0); // enqueue 없음
    expect(fs.existsSync(archiveFilePath())).toBe(false); // 조용한 턴 → 아카이브 write 없음(no-op)
  });

  // SC-010: 자동 아카이브 ON 상태에서 앵커 없는 사용자 초안은 아카이브 이관·inbox 삭제 대상이 되지 않는다.
  it("SC-010: 자동 아카이브 ON — 앵커 없는 사용자 초안은 이관·삭제되지 않고 inbox 에 잔존한다", async () => {
    // 주: 이 "SC-010" 라벨은 007 이전 spec 의 잔존 식별자(STALE_SC, 본 007 SC-010 과 무관 —
    // code-is-truth 비차단, 소급 정정 안 함). 007 T-D3: config-on=autoArchive 레거시 전제 보존.
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "사용자 초안 텍스트\n- [x] sending report to boss\n");

    source = makeSource();
    await source.start();

    await new Promise((r) => setTimeout(r, 250));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).toContain("사용자 초안 텍스트"); // inbox 잔존(삭제 아님)
    expect(inbox).toContain("sending report to boss"); // 원문 라인 파괴 없음
    expect(fs.existsSync(archiveFilePath())).toBe(false); // 아카이브 이관 없음(대상 미수집)
    expect(msgCount()).toBe(0); // 경계·액션 미생성 → enqueue 도 없음
  });

  it("수동(config off): `🗄️ archive` 체크 시 기존 sent 본문을 일괄 이관하고 종단 표기(자동 아님)", async () => {
    // 007 T-D3: layout-on 은 archive 트리거를 "기록 존 마커 prune"(ADR-003, SC-009/010)으로
    // 재정의해 본문 이관(body-move) 의미가 바뀐다 — 이 테스트가 고정하는 body-move 계약은
    // layout=off pin 으로 보존(레거시 archive=body-move 는 T-C1/C2 의 off 분기가 유지).
    conf.markdown!.layout = "off";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "지난 본문\n" + sentLine("old", STAMP) + "\n- [x] 🗄️ archive\n");

    source = makeSource();
    await source.start();

    await waitFor(() => /archived \d+/.test(fs.readFileSync(inboxPath, "utf8")));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).not.toContain("지난 본문"); // 본문 이관
    expect(inbox).toContain(`sent [[${outNoteBase(STAMP, "old")}]]`); // 마커 잔존
    expect(inbox).toMatch(/🗄️ archived 1 \d{8}-\d{6}$/m); // 종단 표기 · auto 없음(config off)
    expect(inbox).not.toContain("· auto");
    expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("지난 본문");
    expect(msgCount()).toBe(0); // 아카이브는 enqueue 미대상
  });

  it("수동+자동: · auto 표기 + 진행 중(sent 아님) 초안은 스윕되지 않는다", async () => {
    // 007 T-D3: body-move archive 계약(off 분기 전용)·config-on=autoArchive 레거시 전제 보존.
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(
      inboxPath,
      "옛 본문\n" + sentLine("s1", STAMP) + "\n작성중 초안\n- [x] 🗄️ archive\n",
    );

    source = makeSource();
    await source.start();

    await waitFor(() => /archived \d+/.test(fs.readFileSync(inboxPath, "utf8")));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).toContain("· auto"); // 자동 활성 표기
    expect(inbox).not.toContain("옛 본문"); // sent 세그먼트 본문 이관
    expect(inbox).toContain("작성중 초안"); // sent 아닌 진행 초안 보존
    expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("옛 본문");
  });

  it("크래시 멱등(Order X): 아카이브 append 후 inbox 미갱신 재기동 — 재전송 없이 본문 이관 수렴", async () => {
    // 007 T-D3: config-on=autoArchive 레거시 전제 보존(layout=off pin). layout-on 크래시
    // 재개는 SC-017 신규 테스트가 커버.
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    // 크래시 재현: sending + 본문 잔존, ledger done entry 존재(이미 enqueue/완료), 아카이브엔 이미 append 됨.
    fs.writeFileSync(inboxPath, "복구 본문\n" + sendingLine("crash-2", STAMP) + "\n");
    fs.writeFileSync(path.join(paths.outDir, "crash-2.out"), "응답");
    writeLedgerEntry("crash-2", {});
    fs.mkdirSync(archiveDirPath(), { recursive: true });
    fs.writeFileSync(archiveFilePath(), `\n## [[${outNoteBase(STAMP, "crash-2")}]]\n\n복구 본문\n`);

    source = makeSource();
    await source.start();

    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(`sent [[${STAMP} crash-2]]`));
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).not.toContain("복구 본문"); // 본문 제거 수렴
    expect(msgCount()).toBe(0); // 재enqueue 없음(hasId dedup)
    // 아카이브엔 본문 존재(재append 로 중복 가능 — 무해)
    expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("복구 본문");
  });

  it("자동: 한 턴 두 세그먼트 — 둘 다 이관·마커 잔존·빈 send 하나(경계·bottom-up splice)", async () => {
    // 007 T-D3: config-on=autoArchive 레거시 전제 보존(layout=off pin).
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "본문하나\n- [x] 📤 send\n본문둘\n- [x] 📤 send\n");

    source = makeSource();
    await source.start();

    await waitFor(() => msgCount() >= 2);
    await waitFor(() => {
      const a = fs.existsSync(archiveFilePath()) ? fs.readFileSync(archiveFilePath(), "utf8") : "";
      return a.includes("본문하나") && a.includes("본문둘");
    });
    // 아카이브 append 는 inbox 재기록보다 먼저다(ORDER 불변식) — 아카이브 내용만으로 read 하면
    // inbox 가 아직 Phase A(sending+본문 잔존) 창에 걸릴 수 있다. inbox 수렴(sent 마커 2개)까지 대기.
    await waitFor(() => {
      const i = fs.readFileSync(inboxPath, "utf8");
      return (i.match(/sent \[\[.+\]\]/g) ?? []).length === 2;
    });

    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).not.toContain("본문하나");
    expect(inbox).not.toContain("본문둘");
    expect(inbox.match(/sent \[\[.+\]\]/g)).toHaveLength(2); // 마커 둘 잔존
    expect(inbox.split("\n").filter((l) => l === blankSendLine())).toHaveLength(1);
    // 문서 순서로 아카이브(본문하나 먼저).
    const archive = fs.readFileSync(archiveFilePath(), "utf8");
    expect(archive.indexOf("본문하나")).toBeLessThan(archive.indexOf("본문둘"));
  });

  it("자동: 중첩 아카이브 경로(부모 부재)도 start 시 부모 생성 후 정상 이관", async () => {
    // 007 T-D3: config-on=autoArchive 레거시 전제 보존(layout=off pin).
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "logs/sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "중첩 경로 본문\n- [x] 📤 send\n");

    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();

    // archive=디렉터리 해석(ADR-003) — logs/sent-archive.md 자체가 디렉터리, 그 아래 날짜 파일.
    const nested = path.join(rootDir, "logs", "sent-archive.md", `${todayDateStr()}.md`);
    await waitFor(
      () => fs.existsSync(nested) && fs.readFileSync(nested, "utf8").includes("중첩 경로 본문"),
    );
    expect(fs.readFileSync(inboxPath, "utf8")).not.toContain("중첩 경로 본문"); // 종단·제거 정상(스톨 없음)
    expect(msgCount()).toBe(1);
  });

  it("자동: 이관 완료 후 재이벤트는 아카이브를 다시 append 하지 않는다(멱등 — 중복 없음)", async () => {
    // 007 T-D3: config-on=autoArchive 레거시 전제 보존(layout=off pin).
    conf.markdown!.layout = "off";
    conf.markdown!.archive = "sent-archive.md";
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "멱등 본문\n- [x] 📤 send\n");

    source = makeSource();
    await source.start();

    await waitFor(
      () =>
        fs.existsSync(archiveFilePath()) &&
        fs.readFileSync(archiveFilePath(), "utf8").includes("멱등 본문"),
    );
    const after1 = fs.readFileSync(archiveFilePath(), "utf8");
    // 조용한 재스캔 유도 + 자기쓰기 echo 가드로 재처리 없음 → 아카이브 불변.
    await new Promise((r) => setTimeout(r, 250));
    expect(fs.readFileSync(archiveFilePath(), "utf8")).toBe(after1); // 재append 없음
    // 본문은 정확히 한 번만 아카이브.
    expect(after1.split("멱등 본문")).toHaveLength(2);
  });

  it("아카이브 경로가 approvals 디렉터리 내부면 start 거부(fail-closed)", async () => {
    conf.markdown!.approvals = "approvals";
    conf.markdown!.archive = "approvals/sent-archive.md";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  // ── Part A 파티셔닝 — 재기록 멱등 (FR-001, SC-009) ──────────────────────────────
  // Happy-path 폴더 배치 자체는 위 "renderOut: origin_ts sidecar" 등 마이그레이션된 baseline 이
  // 이미 커버 — 여기선 재기록 시 중복 폴더가 생기지 않는 멱등성만 추가로 검증한다.
  // SC-009: render 실패 후 재전송되는 markdown 메시지도 동일 origin_ts 로 재호출되므로, 이 재호출이
  // 채널 노트를 중복 생성하지 않음을 확인하는 것이 곧 "소스 dedup 앵커가 채널 중복을 방지" 의 증거다.
  it("renderOut 재호출(같은 origin_ts)은 같은 날짜 폴더의 같은 파일을 갱신하고 중복 폴더를 만들지 않는다", async () => {
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    source = makeSource();
    await source.start();

    const originIso = "2026-07-05T09:00:00.000Z";
    writeLedgerEntry("msg-r", { reply_ref: { channel_msg_id: "msg-r" }, origin_ts: originIso });
    fs.writeFileSync(path.join(paths.outDir, "msg-r.out"), "응답 v1");
    await source.renderOut("msg-r");

    fs.writeFileSync(path.join(paths.outDir, "msg-r.out"), "응답 v2(재렌더)");
    await source.renderOut("msg-r");

    const outboxDir = path.join(rootDir, "out");
    const dateDirs = fs
      .readdirSync(outboxDir)
      .filter(
        (f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && fs.statSync(path.join(outboxDir, f)).isDirectory(),
      );
    expect(dateDirs).toEqual(["2026-07-05"]); // 재렌더로 다른 날짜 폴더가 새로 생기지 않음
    const files = fs.readdirSync(path.join(outboxDir, "2026-07-05"));
    expect(files).toHaveLength(1); // 같은 파일 갱신 — 중복 노트 없음
    expect(fs.readFileSync(path.join(outboxDir, "2026-07-05", files[0]!), "utf8")).toContain(
      "응답 v2(재렌더)",
    );
  });

  // ── 설정 opt-in·기본값 (FR-020·FR-021, SC-017 통합측 — conf.test.ts 는 파싱측) ──────────
  it("backup 미설정 시 이관 기능은 관측 가능한 결과(스캔·전송)에 영향이 없다(NFR-005·SC-025, GAP-001 해석)", async () => {
    // 권장 해석(GAP-001): "산출물 위치 불변"이 아니라 "미설정 시 처리 결과 불변" — 파티셔닝 자체는
    // FR-001~003 대로 상시 적용되되, backup 미설정이 스캔 대상(outbox/.decided)·전송 결과에 영향을
    // 주지 않음을 검증한다(이관 job 미동작이 곧 처리 결과 불변으로 이어짐).
    const inboxPath = path.join(rootDir, "inbox.md");
    fs.writeFileSync(inboxPath, "질문\n- [x] 📤 send\n");
    // conf.markdown 에 backup 관련 키를 일부러 넣지 않는다(opt-in 미설정 상태) — A-01 반영 후
    // 타입에 필드가 생기면 아래 주석을 해제해 실제로 undefined 를 단언한다.
    source = makeSource();
    await source.start();

    await waitFor(() => msgCount() >= 1);
    expect(msgCount()).toBe(1); // 처리(enqueue) 결과 불변
    await waitFor(() => /sent \[\[.+\]\]/.test(fs.readFileSync(inboxPath, "utf8")));
  });
});

// ── 백업/정리 설정 검증 (SC-018·SC-019·SC-021·SC-028 markdown 측) ───────────────
// SC-002(결정완료만 이동)·SC-023(pending·라이브 inbox 제외)은 위 "createMarkdownSource (통합)"
// 마이그레이션된 baseline(.decided 이관 스위트)이 이미 커버 — 중복 신규 작성 안 함.
describe("백업 경로·안전창·제공자 기동 검증 (A-02·C-01 확정 시그니처 대상)", () => {
  let tmpBase: string;
  let rootDir: string;
  let paths: ReturnType<typeof lanePaths>;
  let conf: LaneConf;
  let source: Source | null = null;

  function makeSource(): Source {
    return createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
  }

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-retention-conf-"));
    rootDir = path.join(tmpBase, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    paths = lanePaths(tmpBase, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "");
    conf = {
      source: "markdown",
      backend: "acp",
      engine: "claude",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: [],
      hard_deny: [],
      auto_relaunch: true,
      markdown: { root: rootDir, inbox: "inbox.md" },
    };
  });

  afterEach(() => {
    if (source) source.stop();
    source = null;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("SC-018: 백업 경로가 outbox 와 겹치면 start 거부", async () => {
    conf.markdown!.backup = path.join(rootDir, "out"); // 기본 outboxDir 과 동일 경로(중첩)
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  it("SC-018: vault 밖 절대경로·타 볼륨류 백업 경로는 허용된다(정상 기동)", async () => {
    conf.markdown!.backup = path.join(tmpBase, "ExternalBackup"); // vault(rootDir) 밖
    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();
  });

  it("SC-019: backup 활성 + archive 미설정이면 validate 가 경고를 반환한다(침묵 금지)", () => {
    conf.markdown!.backup = path.join(tmpBase, "ExternalBackup");
    const result = markdownDescriptor.validate!({ conf, opts: {} });
    expect(result.errors).toEqual([]); // 경고이지 하드 오류 아님(생성 자체는 허용)
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("SC-019: backup+archive 둘 다 설정되면 미설정 경고가 나오지 않는다", () => {
    conf.markdown!.backup = path.join(tmpBase, "ExternalBackup");
    conf.markdown!.archive = "sent-archive.md";
    const result = markdownDescriptor.validate!({ conf, opts: {} });
    // root 미존재 등 무관 경고와 섞이지 않도록 backup/archive 문구만 느슨히 확인.
    expect(result.warnings.some((w) => /backup/i.test(w) && /archive/i.test(w))).toBe(false);
  });

  it("SC-021: out_retention_days 가 retention_days+1 미만이면 start 거부", async () => {
    conf.markdown!.retention_days = 2;
    conf.markdown!.out_retention_days = 2; // 2 >= 2+1 아님 → 위배
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  it("SC-021: 안전창 부등식(out_retention_days >= retention_days+1)을 충족하면 정상 기동", async () => {
    conf.markdown!.retention_days = 2;
    conf.markdown!.out_retention_days = 3; // K=1 부등식 충족(ADR-006)
    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();
  });

  it("SC-028: sync_provider 허용값(icloud)은 정상 수용된다", async () => {
    conf.markdown!.sync_provider = "icloud";
    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();
  });

  it("SC-028: 미지원 sync_provider 값(gdrive)은 start 거부(fail-closed) + 사유 표기", async () => {
    conf.markdown!.sync_provider = "gdrive";
    source = makeSource();
    await expect(source!.start()).rejects.toThrow();
  });

  it("SC-028: sync_provider 미설정은 거부 없이 정상 기동(local 간주)", async () => {
    source = makeSource();
    await expect(source!.start()).resolves.toBeUndefined();
  });
});

// ── relocateOldFolders — 라이브 inbox·비날짜 항목 제외 (SC-005) ────────────────
// FR-006: 라이브 inbox 단일 파일은 파티셔닝·이관 대상이 아니다. relocateOldFolders 는 날짜명
// (YYYY-MM-DD) 폴더만 이관 대상으로 판정하므로, 같은 루트에 놓인 inbox 파일(비날짜명)은 readdir
// 목록엔 잡히되 날짜 정규식 미매치로 자연히 대상에서 제외되어야 한다(FR-004 레거시 flat 파일과 동일
// 메커니즘 — 구현 로직 공유, 별도 화이트리스트 불요).
describe("relocateOldFolders — 라이브 inbox 파일은 이관 대상 집합에 포함되지 않는다", () => {
  it("SC-005: vaultDir 에 놓인 inbox.md(비날짜명)는 이관 후에도 원위치에 남는다", async () => {
    const { relocateOldFolders } = await import("../../src/src-adapters/markdown-retention.js");
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-inbox-excl-"));
    try {
      const vaultDir = path.join(tmpBase, "Notes");
      const backupDir = path.join(tmpBase, "Backup");
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path.join(vaultDir, "inbox.md"), "라이브 인박스 본문");
      fs.mkdirSync(path.join(vaultDir, "2026-07-01"), { recursive: true });
      fs.writeFileSync(path.join(vaultDir, "2026-07-01", "note.md"), "옛 노트");

      await relocateOldFolders({
        roots: [{ vaultDir, backupDir, unit: "folder" }],
        cutoffDate: "2026-07-08",
        materialize: async () => "ready",
      });

      expect(fs.existsSync(path.join(vaultDir, "inbox.md"))).toBe(true);
      expect(fs.readFileSync(path.join(vaultDir, "inbox.md"), "utf8")).toBe("라이브 인박스 본문");
      expect(fs.existsSync(path.join(backupDir, "inbox.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

// ── 007 inbox-zoned-layout — 존 레이아웃(팔레트·compose 센티널·기록 존·즉시 아카이브) ──────
// 5a Test AUTHORING(PPG-1). production(A/B/C 레이어)은 4단계 Development 병렬 착수 — 아직
// 미착지된 신규 export(healLayout·planRecordsPrune·paletteLines 등)는 지연(동적) import 로
// 개별 테스트만 격리 RED 시킨다(PROC-R15 — 파일 전체 수집 붕괴 방지). 센티널/앵커 리터럴은
// design.md 확정 상수(`<!-- adde:compose -->`/`<!-- adde:records -->`) 그대로 하드코딩해
// 상수 자체의 미착지로 인한 불필요한 동적 import 를 피한다.
describe("존 레이아웃(inbox-zoned-layout, 007)", () => {
  const COMPOSE_SENTINEL = "<!-- adde:compose -->";
  const RECORDS_ANCHOR = "<!-- adde:records -->";

  let tmpBase: string;
  let rootDir: string;
  let paths: ReturnType<typeof lanePaths>;
  let conf: LaneConf;
  let source: Source | null = null;

  function makeSource(): Source {
    return createMarkdownSource({ lane: "L", proj: "myproj", engine: "claude", paths, conf });
  }

  function msgCount(): number {
    if (!fs.existsSync(paths.queueDir)) return 0;
    return fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length;
  }

  function inboxFilePath(): string {
    return path.join(rootDir, "inbox.md");
  }

  function readInbox(): string {
    return fs.readFileSync(inboxFilePath(), "utf8");
  }

  function todayDateStr(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function archiveDirPath(): string {
    return path.join(rootDir, conf.markdown?.archive ?? "sent-archive");
  }

  function archiveFilePath(): string {
    return path.join(archiveDirPath(), `${todayDateStr()}.md`);
  }

  /** 팔레트+센티널+기록 존이 이미 갖춰진 캔버스 — records 뒤에 임의 줄을 이어붙인다. */
  function zonedFixture(recordsLines: string[]): string {
    return [
      "- [ ] 🗄️ archive",
      "- [ ] 🧹 clear",
      "- [ ] 🗜️ compact",
      "- [ ] ♻️ resume",
      COMPOSE_SENTINEL,
      "",
      "- [ ] 📤 send",
      "## Sent records",
      RECORDS_ANCHOR,
      ...recordsLines,
      "",
    ].join("\n");
  }

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-md-layout-"));
    rootDir = path.join(tmpBase, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    paths = lanePaths(tmpBase, "myproj", "L");
    fs.mkdirSync(paths.outDir, { recursive: true });
    conf = {
      source: "markdown",
      backend: "acp",
      engine: "claude",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: [],
      hard_deny: [],
      auto_relaunch: true,
      markdown: { root: rootDir, inbox: "inbox.md" },
    };
  });

  afterEach(() => {
    if (source) source.stop();
    source = null;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("팔레트(FR-001)", () => {
    it("SC-001: 팔레트 clear 체크 → 실행 → 미체크 복원, 나머지 팔레트 잔존", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([]).replace("- [ ] 🧹 clear", "- [x] 🧹 clear"),
      );
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
      const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as Record<
        string,
        unknown
      >;
      expect(env["control"]).toEqual({ kind: "clear" });

      await waitFor(() => readInbox().includes("- [ ] 🧹 clear"));
      const inbox = readInbox();
      expect(inbox).toContain("- [ ] 🗄️ archive");
      expect(inbox).toContain("- [ ] 🧹 clear");
      expect(inbox).toContain("- [ ] 🗜️ compact");
      expect(inbox).toContain("- [ ] ♻️ resume");
      await new Promise((r) => setTimeout(r, 200));
      expect(msgCount()).toBe(1); // 재발화 없음(자기쓰기 echo 가드) — 1회만 실행
    });

    it("SC-002: 팔레트 compact 체크 → 실행 → 미체크 복원, 나머지 팔레트 잔존", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([]).replace("- [ ] 🗜️ compact", "- [x] 🗜️ compact"),
      );
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      const qFile = fs.readdirSync(paths.queueDir).find((f) => f.endsWith(".msg"))!;
      const env = JSON.parse(fs.readFileSync(path.join(paths.queueDir, qFile), "utf8")) as Record<
        string,
        unknown
      >;
      expect(env["control"]).toEqual({ kind: "compact" });

      await waitFor(() => readInbox().includes("- [ ] 🗜️ compact"));
      const inbox = readInbox();
      // 종단(✅ sent)이 아니라 그 자리 미체크 복원 — 팔레트 4종 모두 미체크로 상주.
      expect(inbox).toContain("- [ ] 🗄️ archive");
      expect(inbox).toContain("- [ ] 🧹 clear");
      expect(inbox).toContain("- [ ] 🗜️ compact");
      expect(inbox).toContain("- [ ] ♻️ resume");
      expect(inbox).not.toMatch(/sent \[\[.+\]\]/); // 제어 라벨은 sent 링크로 종단되지 않는다
      await new Promise((r) => setTimeout(r, 200));
      expect(msgCount()).toBe(1); // 재발화 없음(자기쓰기 echo 가드) — 1회만 실행
    });

    it("SC-001: 미체크 팔레트는 무동작(액션 0)", async () => {
      fs.writeFileSync(inboxFilePath(), zonedFixture([]));
      source = makeSource();
      await source.start();

      await new Promise((r) => setTimeout(r, 200));
      expect(msgCount()).toBe(0);
    });

    it("SC-002: paletteLines() 는 archive·clear·compact·resume 4종 미체크 마커만 생성한다", async () => {
      const { paletteLines } = await import("../../src/src-adapters/markdown.js");
      const lines: string[] = paletteLines();
      expect(lines).toHaveLength(4);
      const cores = lines.map((l) => {
        const m = /^-\s*\[ \]\s+(.*)$/.exec(l);
        expect(m).not.toBeNull();
        return m![1]!.replace(/^[^\p{L}]+/u, "").toLowerCase();
      });
      expect(new Set(cores)).toEqual(new Set(["archive", "clear", "compact", "resume"]));
    });

    it("SC-002: healLayout 출력엔 팔레트 4종이 미체크로 존재하고 신규 라벨은 0건이다", async () => {
      const { healLayout } = await import("../../src/src-adapters/markdown.js");
      const result = healLayout(["임의 초안", "- [x] 📤 send"], { paletteEnabled: true });
      const knownCores = new Set(["archive", "clear", "compact", "resume", "send"]);
      for (const line of result.lines) {
        const m = /^-\s*\[ \]\s+(.*)$/.exec(line);
        if (!m) continue;
        const core = m[1]!.replace(/^[^\p{L}]+/u, "").toLowerCase();
        if (["archive", "clear", "compact", "resume"].includes(core)) continue;
        // 그 외 미체크 체크박스는 팔레트가 아니라 사용자 본문(send 등)이어야 한다 — 신규 명령 라벨 0건.
        expect(knownCores.has(core) || core === "send").toBe(true);
      }
      const paletteCores = result.lines
        .map((l) => /^-\s*\[ \]\s+(.*)$/.exec(l)?.[1])
        .filter((c): c is string => !!c)
        .map((c) => c.replace(/^[^\p{L}]+/u, "").toLowerCase())
        .filter((c) => ["archive", "clear", "compact", "resume"].includes(c));
      expect(new Set(paletteCores)).toEqual(new Set(["archive", "clear", "compact", "resume"]));
    });

    it("SC-002: markdown.palette=off 는 팔레트만 미표시하고 다른 존 동작은 유지한다", async () => {
      conf.markdown!.palette = "off";
      fs.writeFileSync(inboxFilePath(), "");
      source = makeSource();
      await source.start();

      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      const inbox = readInbox();
      expect(inbox).not.toMatch(/-\s*\[ \]\s*🗄️\s*archive/);
      expect(inbox).not.toMatch(/-\s*\[ \]\s*🧹\s*clear/);
      expect(inbox).toContain(COMPOSE_SENTINEL);
      expect(inbox).toContain(RECORDS_ANCHOR);
    });
  });

  describe("compose 센티널(FR-002)", () => {
    it("SC-003: 센티널 기준 본문 추출 — 체크 send 직전 3줄이 enqueue 본문과 정확히 일치", () => {
      const content = [COMPOSE_SENTINEL, "본문1", "본문2", "본문3", "- [x] 📤 send"].join("\n");
      const r = parseInbox(content);
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]).toMatchObject({ kind: "fresh", text: "본문1\n본문2\n본문3" });
    });

    it("SC-003: 센티널 앞(팔레트 영역) 텍스트는 본문에서 배제된다", () => {
      const content = [
        "- [ ] 🗄️ archive",
        "- [ ] 🧹 clear",
        COMPOSE_SENTINEL,
        "실제 본문",
        "- [x] 📤 send",
      ].join("\n");
      const r = parseInbox(content);
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]!.text).toBe("실제 본문");
      expect(r.actions[0]!.text).not.toContain("archive");
      expect(r.actions[0]!.text).not.toContain("clear");
    });

    it("SC-004: 센티널이 없는 레거시 inbox 는 위-읽기 규칙으로 본문을 추출해 정상 전송한다", async () => {
      fs.writeFileSync(inboxFilePath(), "레거시 본문 두 줄\n계속\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
      const env = JSON.parse(
        fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(env["text"]).toBe("레거시 본문 두 줄\n계속");
    });
  });

  describe("기록 존(FR-003)", () => {
    it("SC-005: 진행 중 ⏳ sending 은 기록 존이 아니라 send 위치에 유지된다", async () => {
      // enqueue 실패를 강제해 Phase B(sent 종단) 미도달 상태를 고정 관찰(FR-12 패턴 재사용).
      fs.mkdirSync(path.dirname(paths.queueDir), { recursive: true });
      fs.writeFileSync(paths.queueDir, "block"); // mkdir(recursive) 실패 유도
      fs.writeFileSync(inboxFilePath(), "진행 중 메시지\n- [x] 📤 send\n");

      source = makeSource();
      await source.start();

      await waitFor(() => /⏳\s*sending/.test(readInbox()));
      const lines = readInbox().split("\n");
      const sendingIdx = lines.findIndex((l) => /⏳\s*sending/.test(l));
      const recordsIdx = lines.findIndex((l) => l.includes("adde:records"));
      expect(sendingIdx).toBeGreaterThanOrEqual(0);
      if (recordsIdx >= 0) expect(sendingIdx).toBeLessThan(recordsIdx);
      expect(readInbox()).not.toMatch(/✅\s*sent/);
    });

    it("SC-006: 완료 시 ✅ sent 만 기록 존으로 이동하고 최신-위로 정렬된다", async () => {
      fs.writeFileSync(inboxFilePath(), "첫 메시지\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      await waitFor(() => /✅\s*sent\s*\[\[.+\]\]/.test(readInbox()));
      const firstQFile = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"))[0]!;
      const firstId = (
        JSON.parse(fs.readFileSync(path.join(paths.queueDir, firstQFile), "utf8")) as {
          id: string;
        }
      ).id;

      const afterFirst = readInbox();
      fs.writeFileSync(
        inboxFilePath(),
        afterFirst.replace(blankSendLine(), "두 번째 메시지\n- [x] 📤 send"),
      );
      await waitFor(() => msgCount() >= 2);
      await waitFor(() => (readInbox().match(/✅\s*sent\s*\[\[.+\]\]/g) ?? []).length === 2);

      const finalInbox = readInbox();
      const lines = finalInbox.split("\n");
      const recordsIdx = lines.findIndex((l) => l.includes("adde:records"));
      expect(recordsIdx).toBeGreaterThanOrEqual(0);
      const firstSentIdx = lines.findIndex((l) => l.includes(firstId));
      const secondSentIdx = lines.findIndex(
        (l, i) => i !== firstSentIdx && /✅\s*sent\s*\[\[.+\]\]/.test(l),
      );
      expect(firstSentIdx).toBeGreaterThan(recordsIdx);
      expect(secondSentIdx).toBeGreaterThan(recordsIdx);
      expect(secondSentIdx).toBeLessThan(firstSentIdx); // 최신(두 번째)이 앵커에 더 가깝다(위)
      expect(finalInbox).not.toMatch(/⏳\s*sending/);
    });
  });

  describe("즉시 아카이브(FR-004)", () => {
    it("SC-007: 전송 즉시 본문을 아카이브로 이관하고 inbox 본문은 비운다(설정 미지정도 자동)", async () => {
      fs.writeFileSync(inboxFilePath(), "전송 본문입니다\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      await waitFor(() => fs.existsSync(archiveFilePath()));

      const inbox = readInbox();
      expect(inbox).not.toContain("전송 본문입니다"); // inbox 본문 비움
      expect(inbox).toMatch(/✅\s*sent\s*\[\[.+\]\]/); // 기록 존엔 마커만
      expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("전송 본문입니다");
    });

    // GAP-003(Development Agent 발견): archiveDir 자리에 blocking 파일을 미리 두는 픽스처는
    // start() 가 호출하는 기존 ensureArchiveDirReady()(v0.1.5 이하 단일파일 아카이브 하이브리드
    // 마이그레이션 — legacy 파일을 `.legacy` 로 rename 후 정상 디렉터리 재생성)에 흡수되어 실제
    // append 실패를 유발하지 못한다. start() 가 정상 디렉터리를 만들게 둔 뒤(조용한 1회 기동),
    // 그 디렉터리 자체를 쓰기 금지(chmod)해 "신규 파일 생성"만 막는 방식으로 교체한다 —
    // mkdir(recursive) 는 이미 존재하는 디렉터리에 대해선 조회만으로 성공하므로 무해하고,
    // appendFile 의 신규 파일 생성만 EACCES 로 실패한다(Development 의 독립 재현으로 폴백 정상 확인).
    it("SC-008: 아카이브 append 실패 시 본문은 inbox 에 잔존하고 enqueue 는 정상 완료된다", async () => {
      // root 로 돌면 디렉터리 쓰기 금지(chmod)도 무시돼 실패를 재현할 수 없다 — 환경 한정
      // 스킵(boot-report.test.ts 의 동일 관례).
      if (typeof process.getuid === "function" && process.getuid() === 0) return;

      // 1) 조용한 기동 — ensureArchiveDirReady 가 archiveDir 를 정상(쓰기 가능) 디렉터리로 만들고
      //    self-heal 이 안정화될 때까지 대기한다.
      fs.writeFileSync(inboxFilePath(), "");
      source = makeSource();
      await source.start();
      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      await waitFor(() => fs.existsSync(archiveDirPath()));

      // 2) 이미 만들어진 archiveDir 자체를 쓰기 금지로 전환 — 그 안에 신규 아카이브 파일을
      //    만드는 appendFile 만 EACCES 로 실패한다(ensureArchiveDirReady 는 start() 시점에 이미
      //    지나가 재실행되지 않으므로 self-heal 로 되돌아가 무해화되지 않는다).
      fs.chmodSync(archiveDirPath(), 0o500);
      try {
        fs.writeFileSync(
          inboxFilePath(),
          readInbox().replace(blankSendLine(), "실패해도 남을 본문\n- [x] 📤 send"),
        );

        await waitFor(() => msgCount() >= 1);
        await new Promise((r) => setTimeout(r, 250));
        expect(readInbox()).toContain("실패해도 남을 본문"); // 유실 금지(폴백 — splice 스킵)
        expect(msgCount()).toBe(1); // enqueue 자체는 정상 완료
      } finally {
        fs.chmodSync(archiveDirPath(), 0o700); // afterEach rmSync 가 실패하지 않도록 복원
      }
    });

    it("SC-008: 아카이브 실패 폴백은 본문을 `⏳ sending` 으로 남겨 재전송을 차단한다(sent 종단 금지)", async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      fs.writeFileSync(inboxFilePath(), "");
      source = makeSource();
      await source.start();
      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      await waitFor(() => fs.existsSync(archiveDirPath()));
      fs.chmodSync(archiveDirPath(), 0o500);
      try {
        fs.writeFileSync(
          inboxFilePath(),
          readInbox().replace(blankSendLine(), "재전송 금지 본문\n- [x] 📤 send"),
        );
        await waitFor(() => msgCount() >= 1);
        await new Promise((r) => setTimeout(r, 250));

        const healed = readInbox();
        // 폴백은 본문 마커를 sent 로 종단하지 않고 sending 으로 유지한다(resume 후보 → hasId dedup).
        expect(healed).toContain("재전송 금지 본문"); // 유실 금지
        expect(healed).toMatch(/⏳\s*sending\s+\S+/); // sending 마커 잔존
        expect(healed).not.toMatch(/✅\s*sent\s*\[\[/); // sent 종단 아님(재전송 유발 상태 회피)

        // 재전송 시나리오: 복원된 blank send 를 사용자가 다시 체크해도 잔존 본문은 재전송되지 않는다.
        fs.writeFileSync(inboxFilePath(), readInbox().replace(blankSendLine(), "- [x] 📤 send"));
        await new Promise((r) => setTimeout(r, 400));
        expect(msgCount()).toBe(1); // 재전송 없음(sending 마커 + hasId dedup)
      } finally {
        fs.chmodSync(archiveDirPath(), 0o700);
      }
    });

    it("SC-008: 아카이브 복구 후 재기동 시 sending 본문이 재전송 없이 sent 로 수렴·아카이브된다", async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) return;
      fs.writeFileSync(inboxFilePath(), "");
      source = makeSource();
      await source.start();
      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      await waitFor(() => fs.existsSync(archiveDirPath()));
      fs.chmodSync(archiveDirPath(), 0o500);
      fs.writeFileSync(
        inboxFilePath(),
        readInbox().replace(blankSendLine(), "수렴 본문\n- [x] 📤 send"),
      );
      await waitFor(() => msgCount() >= 1);
      await waitFor(() => /⏳\s*sending/.test(readInbox()));

      // 아카이브 복구 후 재기동 — sending 마커는 크래시 재개와 동일하게 재기동 시 수렴한다.
      source.stop();
      fs.chmodSync(archiveDirPath(), 0o700);
      source = makeSource();
      await source.start();

      await waitFor(() => /✅\s*sent\s*\[\[/.test(readInbox()));
      const finalInbox = readInbox();
      expect(finalInbox).not.toMatch(/⏳\s*sending/); // sending → sent 수렴
      expect(finalInbox).not.toContain("수렴 본문"); // 본문은 아카이브로 이관됨
      expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("수렴 본문"); // 아카이브 착지
      expect(msgCount()).toBe(1); // 재전송 없음(hasId dedup — 단 1회 enqueue)
    });
  });

  describe("archive 재정의(FR-005)", () => {
    it("SC-009: archive 트리거 — 기록 존 strict 마커 줄 삭제 + `archived N` 요약 1줄", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([
          sentLine("a1", STAMP),
          sentLine("a2", STAMP),
          sentLine("a3", STAMP),
          emptyLine(),
        ]).replace("- [ ] 🗄️ archive", "- [x] 🗄️ archive"),
      );
      source = makeSource();
      await source.start();

      await waitFor(() => /archived\s+4\s+\d{8}-\d{6}/.test(readInbox()));
      const inbox = readInbox();
      expect(inbox).not.toContain(sentLine("a1", STAMP));
      expect(inbox).not.toContain(sentLine("a2", STAMP));
      expect(inbox).not.toContain(sentLine("a3", STAMP));
      expect(inbox).not.toContain(emptyLine());
      expect(inbox).toMatch(/archived 4 \d{8}-\d{6}/);
    });

    it("SC-009: planRecordsPrune 단위 — strict `✅ sent`/`⚠️ empty` 줄만 수집·count", async () => {
      const { planRecordsPrune } = await import("../../src/src-adapters/markdown.js");
      const lines = [
        "<!-- adde:records -->",
        sentLine("a1", STAMP),
        sentLine("a2", STAMP),
        emptyLine(),
      ];
      const plan = planRecordsPrune(lines, 0);
      expect(plan.count).toBe(3);
      expect(plan.removeIndices.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it("SC-010: archive 트리거는 레거시 `sent <id>`·기존 `archived N` 줄을 건너뛴다", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([
          "- [x] ✅ sent legacy-id",
          archivedLine(2, STAMP, false),
          sentLine("b1", STAMP),
        ]).replace("- [ ] 🗄️ archive", "- [x] 🗄️ archive"),
      );
      source = makeSource();
      await source.start();

      await waitFor(() => /archived\s+1\s+\d{8}-\d{6}/.test(readInbox()));
      const inbox = readInbox();
      expect(inbox).toContain("- [x] ✅ sent legacy-id"); // 레거시 잔존
      expect(inbox).toContain(archivedLine(2, STAMP, false)); // 기존 archived 잔존
      expect(inbox).not.toContain(sentLine("b1", STAMP)); // strict 만 삭제
      expect(inbox).toMatch(/archived 1 \d{8}-\d{6}/);
    });

    it("SC-010: planRecordsPrune 단위 — 레거시·기존 archived 줄 skip", async () => {
      const { planRecordsPrune } = await import("../../src/src-adapters/markdown.js");
      const lines = [
        "<!-- adde:records -->",
        "- [x] ✅ sent legacy-id",
        archivedLine(2, STAMP, false),
        sentLine("b1", STAMP),
      ];
      const plan = planRecordsPrune(lines, 0);
      expect(plan.count).toBe(1);
      expect(plan.removeIndices).toEqual([3]);
    });
  });

  describe("self-heal(FR-006)", () => {
    it("SC-011: self-heal 이 팔레트·센티널·기록 존 앵커를 무유실로 복원한다", async () => {
      fs.writeFileSync(inboxFilePath(), "작성 중인 초안\n" + sentLine("prev-1", STAMP) + "\n");
      source = makeSource();
      await source.start();

      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      const inbox = readInbox();
      expect(inbox).toContain(COMPOSE_SENTINEL);
      expect(inbox).toContain(RECORDS_ANCHOR);
      expect(inbox).toContain("작성 중인 초안"); // 초안 유실 없음
      expect(inbox).toContain(sentLine("prev-1", STAMP)); // 기존 기록 유실 없음
      expect(inbox.split("\n").filter((l) => l === blankSendLine())).toHaveLength(1);
      expect(msgCount()).toBe(0); // self-heal 자체는 전송이 아니다(액션 없음)
    });

    it("SC-012: healLayout 을 2연속 실행하면 멱등(2회차 == 1회차, 중복 생성 없음)", async () => {
      const { healLayout } = await import("../../src/src-adapters/markdown.js");
      const seed = ["온전하지 않은 초안", "- [x] 📤 send"];
      const first = healLayout([...seed], { paletteEnabled: true });
      const second = healLayout([...first.lines], { paletteEnabled: true });
      expect(second.changed).toBe(false);
      expect(second.lines).toEqual(first.lines);
    });
  });

  describe("conf(FR-008)", () => {
    it("SC-014: conf 미지정 레인은 기본으로 레이아웃(팔레트·센티널·기록존)이 켜진다", async () => {
      fs.writeFileSync(inboxFilePath(), "");
      source = makeSource();
      await source.start();

      await waitFor(() => readInbox().includes(COMPOSE_SENTINEL));
      const inbox = readInbox();
      expect(inbox).toContain(COMPOSE_SENTINEL);
      expect(inbox).toContain(RECORDS_ANCHOR);
      expect(inbox).toMatch(/-\s*\[ \]\s*🗄️\s*archive/);
      expect(inbox).toMatch(/-\s*\[ \]\s*🧹\s*clear/);
      expect(inbox).toMatch(/-\s*\[ \]\s*🗜️\s*compact/);
      expect(inbox).toMatch(/-\s*\[ \]\s*♻️\s*resume/);
    });

    it("SC-015: markdown.archive 는 디렉터리 오버라이드 의미만 갖는다(자동 아카이브는 항상 활성)", async () => {
      conf.markdown!.archive = "custom-archive-dir";
      fs.writeFileSync(inboxFilePath(), "커스텀 경로 본문\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      const customArchiveFile = path.join(rootDir, "custom-archive-dir", `${todayDateStr()}.md`);
      await waitFor(() => fs.existsSync(customArchiveFile));
      expect(fs.readFileSync(customArchiveFile, "utf8")).toContain("커스텀 경로 본문");
    });
  });

  describe("기록 존 자동 상한(records_cap)", () => {
    // 단위 — planRecordsCap 순수 함수(recordsStart=0 으로 배열 전체를 기록 존으로 취급).
    it("cap 이하이면 무동작(멱등)", () => {
      const lines = [sentLine("m3", STAMP), sentLine("m2", STAMP), sentLine("m1", STAMP)];
      expect(planRecordsCap(lines, 0, 3, STAMP).changed).toBe(false); // 3 <= 3
    });

    it("cap 초과 시 최근 1건만 남기고 나머지를 단일 archived 요약으로 정리", () => {
      const lines = [
        sentLine("m4", STAMP),
        sentLine("m3", STAMP),
        sentLine("m2", STAMP),
        sentLine("m1", STAMP),
      ];
      const r = planRecordsCap(lines, 0, 3, STAMP); // 4 > 3
      expect(r.changed).toBe(true);
      expect(r.lines).toHaveLength(2); // 최근 1 + 요약 1
      const sent = r.lines.filter((l) => /✅\s*sent/.test(l));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("m4"); // 최신-위라 맨 위(m4)가 최근
      expect(r.lines.some((l) => /🗄️\s*archived\s+3\b/.test(l))).toBe(true); // 3건 요약
    });

    it("기존 archived 요약과 누계 병합(요약줄 누적 방지)", () => {
      const lines = [
        sentLine("m4", STAMP),
        sentLine("m3", STAMP),
        sentLine("m2", STAMP),
        sentLine("m1", STAMP),
        archivedLine(6, STAMP, true), // 기존 누계
      ];
      const r = planRecordsCap(lines, 0, 3, STAMP);
      expect(r.lines.filter((l) => /archived/.test(l))).toHaveLength(1); // 요약 1줄로 병합
      expect(r.lines.some((l) => /🗄️\s*archived\s+9\b/.test(l))).toBe(true); // 6 + 3 = 9
      expect(r.lines).toHaveLength(2);
    });

    it("기존 archived 요약이 여러 개여도 모두 누계 병합(단일 줄)", () => {
      const lines = [
        sentLine("m3", STAMP),
        sentLine("m2", STAMP),
        sentLine("m1", STAMP),
        archivedLine(4, STAMP, true),
        archivedLine(5, STAMP, true),
      ];
      const r = planRecordsCap(lines, 0, 2, STAMP); // strict 3 > 2
      expect(r.lines.filter((l) => /archived/.test(l))).toHaveLength(1); // 여러 요약 → 1줄 병합
      expect(r.lines.some((l) => /🗄️\s*archived\s+11\b/.test(l))).toBe(true); // 4 + 5 + 2 = 11
      expect(r.lines).toHaveLength(2); // 최근 1 + 병합 요약 1
    });

    it("정상상태([최근1, archived N]) 재입력 시 무동작(멱등 — 요약 반복 누적 없음)", () => {
      const steady = [sentLine("m1", STAMP), archivedLine(9, STAMP, true)];
      const r = planRecordsCap(steady, 0, 2, STAMP); // strict 1 <= 2
      expect(r.changed).toBe(false);
      expect(r.lines).toBe(steady); // 동일 배열 참조 반환(무변경)
    });

    it("⚠️ empty 마커도 상한 카운트에 포함된다", () => {
      const lines = [
        sentLine("m3", STAMP),
        "- [x] ⚠️ empty",
        sentLine("m2", STAMP),
        sentLine("m1", STAMP),
      ];
      expect(planRecordsCap(lines, 0, 3, STAMP).changed).toBe(true); // strict 4 > 3
    });

    // 통합 — 전송으로 상한을 넘겨 자동 정리 발화(본문은 아카이브 보존).
    it("SC: records_cap 초과 전송 시 최근 1건 유지 + 누계 요약, 본문은 아카이브 보존", async () => {
      conf.markdown!.records_cap = 2;
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([sentLine("old2", STAMP), sentLine("old1", STAMP)]),
      );
      source = makeSource();
      await source.start();
      await waitFor(() => readInbox().includes(blankSendLine()));

      fs.writeFileSync(
        inboxFilePath(),
        readInbox().replace(blankSendLine(), "새 메시지 본문\n- [x] 📤 send"),
      );
      await waitFor(() => /🗄️\s*archived\s+2\b/.test(readInbox())); // old1·old2 → 요약 2
      const inbox = readInbox();
      expect((inbox.match(/✅\s*sent/g) ?? []).length).toBe(1); // 최근(새 메시지)만
      expect(fs.existsSync(archiveFilePath())).toBe(true);
      expect(fs.readFileSync(archiveFilePath(), "utf8")).toContain("새 메시지 본문"); // 본문 유실 없음
      expect(msgCount()).toBe(1); // 재전송 없음
    });

    it("SC: records_cap 미지정이면 자동 정리 없이 sent 마커가 누적된다", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        zonedFixture([sentLine("old2", STAMP), sentLine("old1", STAMP)]),
      );
      source = makeSource();
      await source.start();
      await waitFor(() => readInbox().includes(blankSendLine()));

      fs.writeFileSync(
        inboxFilePath(),
        readInbox().replace(blankSendLine(), "세 번째 본문\n- [x] 📤 send"),
      );
      await waitFor(() => (readInbox().match(/✅\s*sent/g) ?? []).length >= 3);
      await new Promise((r) => setTimeout(r, 150));
      const inbox = readInbox();
      expect((inbox.match(/✅\s*sent/g) ?? []).length).toBe(3); // 누적, 정리 없음
      expect(inbox).not.toMatch(/🗄️\s*archived\s+\d+.*·\s*auto/); // 자동 요약 없음
    });
  });

  describe("불변식(NFR-001/NFR-002)", () => {
    it("SC-016: 팔레트 복원·이사·아카이브·self-heal 순차 재작성이 재전송·중복·유실을 유발하지 않는다", async () => {
      fs.writeFileSync(inboxFilePath(), "메시지\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      await waitFor(() => /✅\s*sent/.test(readInbox()));
      await new Promise((r) => setTimeout(r, 300)); // 조용한 관찰 구간 — 재발화 루프 여부 확인
      expect(msgCount()).toBe(1);
    });

    it("SC-017: ⏳ sending 상태로 중단된 inbox 재기동 시 누락분만 정확히 1회 재전송된다", async () => {
      fs.writeFileSync(
        inboxFilePath(),
        `크래시 복구 메시지\n${sendingLine("crash-zone-1", STAMP)}\n`,
      );
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
      expect(files.some((f) => f.includes("crash-zone-1"))).toBe(true);
      await waitFor(() => /✅\s*sent/.test(readInbox()));
      await new Promise((r) => setTimeout(r, 200));
      expect(msgCount()).toBe(1); // 중복 enqueue 없음
    });
  });

  describe("하위호환(NFR-003)", () => {
    it("SC-018: 레거시 inbox(센티널·팔레트·앵커 없음)도 폴백·self-heal 로 무중단 전송된다", async () => {
      fs.writeFileSync(inboxFilePath(), "레거시 본문\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      expect(msgCount()).toBe(1);
    });

    it("SC-018: markdown.layout=off 는 기존(레이아웃 도입 이전) inbox 동작과 호환된다", async () => {
      conf.markdown!.layout = "off";
      fs.writeFileSync(inboxFilePath(), "레거시 동작 유지\n- [x] 📤 send\n");
      source = makeSource();
      await source.start();

      await waitFor(() => msgCount() >= 1);
      await waitFor(() => readInbox().includes("sent"));
      const inbox = readInbox();
      expect(inbox).not.toContain(COMPOSE_SENTINEL);
      expect(inbox).not.toContain(RECORDS_ANCHOR);
      expect(inbox).toMatch(/✅\s*sent\s*\[\[.+\]\]/);
    });
  });
});
