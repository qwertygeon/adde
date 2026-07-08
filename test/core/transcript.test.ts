import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendTranscript } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";
import { readLogs } from "../../src/core/diagnostics.js";

// SC-006: agent_message_chunk → transcript.log append (이전 내용 보존)
// SC-007: 토큰 마스킹 (maskSecrets 통합)

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-transcript-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("appendTranscript (SC-006 append 보존)", () => {
  it("agent_message_chunk 이벤트를 transcript.log 에 append 한다", async () => {
    const event = {
      type: "agent_message_chunk" as const,
      content: "안녕하세요",
    };
    await appendTranscript(paths, event);
    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).toContain("안녕하세요");
  });

  it("기존 내용을 보존하고 새 텍스트를 추가한다 (append)", async () => {
    // 기존 내용
    fs.writeFileSync(paths.transcriptLog, "기존 로그 내용\n");

    const event = { type: "agent_message_chunk" as const, content: "새로운 내용" };
    await appendTranscript(paths, event);

    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).toContain("기존 로그 내용");
    expect(content).toContain("새로운 내용");
  });

  it("여러 번 append 하면 순서대로 누적된다", async () => {
    for (const text of ["첫째", "둘째", "셋째"]) {
      await appendTranscript(paths, { type: "agent_message_chunk" as const, content: text });
    }
    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    const firstPos = content.indexOf("첫째");
    const secondPos = content.indexOf("둘째");
    const thirdPos = content.indexOf("셋째");
    expect(firstPos).toBeLessThan(secondPos);
    expect(secondPos).toBeLessThan(thirdPos);
  });
});

describe("appendTranscript 토큰 마스킹 (SC-007)", () => {
  it("봇 토큰 형식 문자열이 마스킹되어 transcript.log 에 기록된다", async () => {
    // 봇 토큰 패턴: \d{5,}:[A-Za-z0-9_-]{35} — 콜론 뒤 35자 필수
    const token = "123456789:AAECBAUGBwgJCgsMDQ4PEBESExQVFhcYGRob";
    const event = { type: "agent_message_chunk" as const, content: `메시지에 토큰 ${token} 포함` };
    await appendTranscript(paths, event);
    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).not.toContain(token);
    expect(content).toContain("***");
  });
});

// SC-010 (FR-010): 회전 후에도 현재 로그를 정상 읽는다(기존 계약 — 마지막 N줄 출력) 유지.
describe("appendTranscript 옵션 3번째 인자 — 회전 트리거 (SC-010 Happy)", () => {
  it("작은 maxBytes 로 회전이 발생해도 이후 읽기 경로(readLogs)가 현재 로그를 정상 반환한다", async () => {
    const rotateOpts = { rotate: { maxBytes: 50, keep: 2 } };
    for (let i = 0; i < 10; i++) {
      await appendTranscript(paths, { type: "agent_message_chunk" as const, content: `line-${i}` }, rotateOpts);
    }

    // 회전이 최소 1회 발생했어야 한다(임계 50바이트 대비 10줄 누적).
    expect(fs.existsSync(`${paths.transcriptLog}.1`)).toBe(true);

    const res = await readLogs("myproj", "test-lane", 5, { base: tmpBase });
    expect(res.exists).toBe(true);
    expect(res.lines.length).toBeGreaterThan(0);
    // 마지막에 기록한 이벤트가 현재 로그(가장 최신 세대)에 존재해야 한다.
    expect(res.lines.join("\n")).toContain("line-9");
  });

  it("opts 미지정(기존 2-인자 호출)은 하위호환 — 소형 로그에서 회전이 트리거되지 않는다", async () => {
    await appendTranscript(paths, { type: "agent_message_chunk" as const, content: "small" });
    expect(fs.existsSync(`${paths.transcriptLog}.1`)).toBe(false);
    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).toContain("small");
  });
});
