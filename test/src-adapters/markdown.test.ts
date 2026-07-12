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
    const r = parseInbox(
      "안녕하세요 질문이 있습니다\n- [x] sent invoice to client\n- [x] 📤 send",
    );
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
  it("미체크 빈 send 가 없으면 끝에 하나 추가하고 true 를 반환한다 (문서 관습 이모지 표기)", () => {
    const lines = ["보낸 메시지", sentLine("id-1", STAMP)];
    expect(ensureBlankSend(lines)).toBe(true);
    expect(lines[lines.length - 1]).toBe(blankSendLine());
    expect(blankSendLine()).toBe("- [ ] 📤 send");
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
    expect(lines[lines.length - 1]).toBe(blankSendLine());
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

    // M8: 소모된 send 를 대체할 빈 send 가 정확히 하나 준비된다(단일 write 통합).
    await waitFor(() => fs.readFileSync(inboxPath, "utf8").includes(blankSendLine()));
    const finalInbox = fs.readFileSync(inboxPath, "utf8");
    const blanks = finalInbox.split("\n").filter((l) => l === blankSendLine());
    expect(blanks).toHaveLength(1);
    // finding2 회귀: 트레일링 개행 누적 없음 + sent 와 blank send 사이 공백줄 없음(개행 위생).
    expect(finalInbox.endsWith("\n\n")).toBe(false);
    expect(finalInbox).not.toContain("\n\n" + blankSendLine());

    // 자기쓰기 가드: 종단 후 추가 enqueue 없음(빈 send 추가는 미체크라 재트리거 안 됨)
    await new Promise((r) => setTimeout(r, 200));
    expect(msgCount()).toBe(1);
  });

  it("M8: 미체크 send 가 없는 inbox(재기동·삭제)면 빈 send 를 self-heal 한다 (액션 없음)", async () => {
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
    await waitFor(() => fs.existsSync(path.join(approvals, ".decided", decidedDate, "req-term.md")));
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

  it("renderOut(id) 호출 시 마크다운 출력 노트를 작성한다(reply_ref 역참조 포함)", async () => {
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
    expect(note).toContain("orig-9");
  });

  it("제어 라벨 체크 → control envelope 큐잉 + sent 위키링크 종단", async () => {
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

    // 라벨 라인이 sent 위키링크로 종단(재트리거 방지 + 결과 노트 링크)
    await waitFor(() => /sent \[\[.+\]\]/.test(fs.readFileSync(inboxPath, "utf8")));
  });

  it("resume 번호 라벨은 세션 장부 최신순으로 해석된다", async () => {
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
  });

  it("E2E 계약: sent 위키링크 텍스트 == renderOut 노트 파일명 (전 경로 관통)", async () => {
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
    expect(
      fs.existsSync(path.join(rootDir, "out", dateFolderFromStamp(stamp), `${link}.md`)),
    ).toBe(true);
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
      .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && fs.statSync(path.join(outboxDir, f)).isDirectory());
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
