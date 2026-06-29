import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendTranscript } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";

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
