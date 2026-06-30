import { describe, expect, it } from "vitest";
import { collectInteractive } from "../../src/cli/lane.js";
import type { Ask } from "../../src/cli/lane.js";

// SC1/SC2: --interactive 가 소스별 필드를 모으고, 토큰은 묻지 않는다(시크릿 비노출).

/** 스크립트된 응답으로 ask 를 흉내낸다. 질문에 매칭되는 키의 값을 반환, 없으면 기본값(빈 입력). */
function scriptedAsk(answers: Record<string, string>): { ask: Ask; questions: string[] } {
  const questions: string[] = [];
  const ask: Ask = async (q, def) => {
    questions.push(q);
    for (const [key, val] of Object.entries(answers)) {
      if (q.includes(key)) return val;
    }
    return def ?? ""; // 빈 입력 → 기본값
  };
  return { ask, questions };
}

describe("collectInteractive (007 SC1)", () => {
  it("telegram: 응답을 opts 로 모으고 markdown 전용 필드는 묻지 않는다", async () => {
    const { ask, questions } = scriptedAsk({
      source: "telegram",
      chat_id: "12345",
      allowlist: "Read,Bash",
    });
    const opts = await collectInteractive(ask);

    expect(opts.source).toBe("telegram");
    expect(opts.engine).toBe("claude-code-acp"); // 빈 입력 → 기본값
    expect(opts.channel).toBe("telegram"); // 기본값 = source
    expect(opts.chat_id).toBe("12345");
    expect(opts.allowlist).toEqual(["Read", "Bash"]);
    expect(opts.root).toBeUndefined();
    // 토큰은 절대 묻지 않는다(SC2)
    expect(questions.some((q) => q.toLowerCase().includes("token") || q.includes("토큰"))).toBe(
      false,
    );
  });

  it("markdown: root/inbox 등 markdown 필드를 묻고 chat_id 는 안 묻는다", async () => {
    const { ask, questions } = scriptedAsk({
      "source (telegram/markdown)": "markdown",
      "root (markdown": "/vault",
    });
    const opts = await collectInteractive(ask);

    expect(opts.source).toBe("markdown");
    expect(opts.channel).toBe("markdown");
    expect(opts.root).toBe("/vault");
    expect(opts.inbox).toBe("inbox.md"); // 기본값
    expect(opts.chat_id).toBeUndefined();
    expect(questions.some((q) => q.includes("chat_id"))).toBe(false);
  });

  it("잘못된 source 는 유효값이 올 때까지 재질의한다", async () => {
    let calls = 0;
    const ask: Ask = async (q) => {
      if (q.includes("source") || q.includes("telegram 또는 markdown")) {
        calls++;
        return calls < 2 ? "bogus" : "telegram";
      }
      return "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.source).toBe("telegram");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
