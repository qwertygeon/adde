import { describe, expect, it } from "vitest";
import { collectInteractive, shouldRunInteractive } from "../../src/cli/lane.js";
import type { Ask } from "../../src/cli/lane.js";

describe("shouldRunInteractive (대화형 default 디스패치)", () => {
  it("맨 인자 + TTY 면 대화형", () => {
    expect(shouldRunInteractive({}, true)).toBe(true);
  });
  it("비-TTY 면 대화형 아님(스크립트가 행 걸리지 않음)", () => {
    expect(shouldRunInteractive({}, false)).toBe(false);
  });
  it("--interactive 는 비-TTY 여도 대화형(호출부가 TTY 없으면 오류 처리)", () => {
    expect(shouldRunInteractive({ interactive: true }, false)).toBe(true);
  });
  it("--no-interactive 는 TTY 여도 비대화형", () => {
    expect(shouldRunInteractive({ "no-interactive": true }, true)).toBe(false);
  });
  it("필드 값 플래그가 있으면 TTY 여도 비대화형(스크립트 의도)", () => {
    expect(shouldRunInteractive({ source: "telegram" }, true)).toBe(false);
    expect(shouldRunInteractive({ "perm-tier": "acp" }, true)).toBe(false);
  });
  it("--safe-defaults·--token-stdin 도 필드 플래그로 취급(비대화형)", () => {
    expect(shouldRunInteractive({ "safe-defaults": true }, true)).toBe(false);
    expect(shouldRunInteractive({ "token-stdin": true }, true)).toBe(false);
  });
  it("--force 만 있고 TTY 면 여전히 대화형(force 는 필드 플래그 아님)", () => {
    expect(shouldRunInteractive({ force: true }, true)).toBe(true);
  });
  it("--interactive 는 필드 플래그가 있어도 대화형(명시 우선)", () => {
    expect(shouldRunInteractive({ interactive: true, source: "telegram" }, true)).toBe(true);
  });
});

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
    expect(opts.engine).toBe("claude-agent-acp"); // 빈 입력 → 기본값
    expect(opts.chat_id).toBe("12345");
    expect(opts.allowlist).toEqual(["Read", "Bash"]);
    expect(opts.root).toBeUndefined();
    // 토큰은 절대 묻지 않는다(SC2)
    expect(questions.some((q) => q.toLowerCase().includes("token") || q.includes("토큰"))).toBe(
      false,
    );
  });

  it("markdown: 번호(1)로 source 선택, root/inbox 등 markdown 필드를 묻고 chat_id 는 안 묻는다", async () => {
    const { ask, questions } = scriptedAsk({
      source: "1", // 번호 선택 → 첫 옵션(markdown)
      "root (markdown": "/vault",
    });
    const opts = await collectInteractive(ask);

    expect(opts.source).toBe("markdown");
    expect(opts.root).toBe("/vault");
    expect(opts.inbox).toBe("inbox.md"); // 기본값
    expect(opts.chat_id).toBeUndefined();
    expect(questions.some((q) => q.includes("chat_id"))).toBe(false);
  });

  it("번호 선택: source=2→telegram, perm_tier=2→autopass 로 매핑한다", async () => {
    const { ask } = scriptedAsk({ source: "2", perm_tier: "2" });
    const opts = await collectInteractive(ask);
    expect(opts.source).toBe("telegram");
    expect(opts.perm_tier).toBe("autopass");
  });

  it("잘못된 source 는 유효값이 올 때까지 재질의한다", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("source") || (q.includes("markdown") && q.includes("telegram"))) {
        calls++;
        return calls < 2 ? "bogus" : "telegram";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.source).toBe("telegram");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("enum 필드(perm_tier)는 유효값이 올 때까지 재질의한다 (B1)", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("perm_tier")) {
        calls++;
        return calls < 2 ? "bogus" : "autopass";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.perm_tier).toBe("autopass");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("숫자 필드(chat_id)는 유효값이 올 때까지 재질의한다 (B1)", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("source")) return "telegram";
      if (q.includes("chat_id")) {
        calls++;
        return calls < 2 ? "not-a-number" : "12345";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.chat_id).toBe("12345");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("enum 필드(file_mode)는 유효값이 올 때까지 재질의한다 (B1)", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("file_mode")) {
        calls++;
        return calls < 2 ? "bogus" : "shared";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.file_mode).toBe("shared");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("enum 필드(lang)는 유효값이 올 때까지 재질의한다 (B1)", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("lang")) {
        calls++;
        return calls < 2 ? "fr" : "ko";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.lang).toBe("ko");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("id-csv 필드(allow_from)는 유효값이 올 때까지 재질의한다 (B1)", async () => {
    let calls = 0;
    const ask: Ask = async (q, def) => {
      if (q.includes("source")) return "telegram";
      if (q.includes("allow_from")) {
        calls++;
        return calls < 2 ? "not,numbers" : "111,222";
      }
      return def ?? "";
    };
    const opts = await collectInteractive(ask);
    expect(opts.allow_from).toBe("111,222"); // CSV 원문(파싱은 lane-config 가 담당)
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("askSecret 가 주어지면 토큰을 가려진 입력으로 수집한다 (B2)", async () => {
    const { ask } = scriptedAsk({ source: "telegram" });
    let secretAsked = false;
    const askSecret = async (): Promise<string> => {
      secretAsked = true;
      return "111:ABCDEF";
    };
    const opts = await collectInteractive(ask, askSecret);
    expect(secretAsked).toBe(true);
    expect(opts.token).toBe("111:ABCDEF");
  });

  it("askSecret 미제공 시 토큰을 수집하지 않는다(생성 후 위임)", async () => {
    const { ask } = scriptedAsk({ source: "telegram" });
    const opts = await collectInteractive(ask);
    expect(opts.token).toBeUndefined();
  });
});
