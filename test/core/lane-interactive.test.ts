import { describe, expect, it } from "vitest";
import { collectInteractive, shouldRunInteractive } from "../../src/cli/lane.js";
import type { Ask } from "../../src/cli/lane.js";
import { SOURCE_REGISTRY } from "../../src/src-adapters/index.js";
import type { LaneAddResult } from "../../src/core/lane-config.js";

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
    // engine 은 실배선되지 않는(지원 값이 하나뿐인) 노브라 프롬프트 자체가 제거됐다 — collectInteractive
    // 는 더 이상 opts.engine 을 채우지 않고, 미지정 시 laneAdd 가 기본값을 기록한다.
    expect(opts.engine).toBeUndefined();
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

  it("enum 프롬프트는 안내 줄을 별도 마지막 줄로 두어 기본값이 옵션에 밀착하지 않는다", async () => {
    const { ask, questions } = scriptedAsk({ source: "markdown", "root (markdown": "/v" });
    await collectInteractive(ask);
    const sourceQ = questions.find((q) => q.startsWith("source"));
    expect(sourceQ).toBeDefined();
    const lines = (sourceQ as string).split("\n");
    // 마지막 줄 = 안내 줄(번호/값 입력). 옵션 줄(  2) telegram)에는 안내·기본값이 붙지 않는다.
    expect(lines[lines.length - 1]).not.toMatch(/^\s*\d+\)/);
    expect(lines.some((l) => /^\s*2\)\s*telegram\s*$/.test(l))).toBe(true);
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

// SC-008 (FR-006): 위저드 프롬프트·생성 후 힌트가 소스 정의(descriptor.wizard) 위임으로 제공된다.
// collectInteractive 를 통한 소스별 필드 수집(블랙박스, 위 007 SC1 스위트와 동일 계약)은 회귀로
// 이미 보존되므로, 여기서는 descriptor.wizard 자체의 존재·형태(FR-006 계약)를 직접 대조한다.
describe("SC-008: 위저드/힌트가 descriptor.wizard 위임으로 제공된다", () => {
  const makeConf = (source: string): LaneAddResult["conf"] => ({
    source,
    backend: "acp",
    engine: "claude-agent-acp",
    perm_tier: "acp",
    acp_version: "v1",
    allowlist: [],
    denylist: [],
    hard_deny: [],
    auto_relaunch: true,
  });

  it("telegram descriptor 는 wizard.collect·wizard.postCreateHint 를 제공한다", () => {
    expect(typeof SOURCE_REGISTRY["telegram"]?.wizard?.collect).toBe("function");
    expect(typeof SOURCE_REGISTRY["telegram"]?.wizard?.postCreateHint).toBe("function");
  });

  it("markdown descriptor 는 wizard.collect 만 제공하고 postCreateHint 는 미제공이다(FR-007 훅 생략)", () => {
    expect(typeof SOURCE_REGISTRY["markdown"]?.wizard?.collect).toBe("function");
    expect(SOURCE_REGISTRY["markdown"]?.wizard?.postCreateHint).toBeUndefined();
  });

  it("telegram wizard.postCreateHint 는 토큰 다음 조치를 안내하는 힌트를 반환한다(기존 lane.tokenNext 위임)", () => {
    const result: LaneAddResult = {
      lane: "tg",
      confPath: "/base/proj/lanes.d/tg.conf",
      conf: makeConf("telegram"),
      warnings: [],
    };
    const hint = SOURCE_REGISTRY["telegram"]?.wizard?.postCreateHint?.(result);
    expect(hint).toBeDefined();
    expect(hint).toContain(".env");
  });

  it("telegram wizard.collect 는 chat_id/allow_from 을 수집하고 markdown 필드는 다루지 않는다", async () => {
    const { ask, questions } = scriptedAsk({ chat_id: "12345", allow_from: "1,2" });
    const fields = await SOURCE_REGISTRY["telegram"]!.wizard!.collect({ ask });
    expect(fields.chat_id).toBe("12345");
    expect(fields.allow_from).toBe("1,2");
    expect(questions.some((q) => q.includes("root"))).toBe(false);
  });

  it("markdown wizard.collect 는 root/inbox 를 수집하고 telegram 필드는 다루지 않는다", async () => {
    const { ask } = scriptedAsk({ "root (markdown": "/vault" });
    const fields = await SOURCE_REGISTRY["markdown"]!.wizard!.collect({ ask });
    expect(fields.root).toBe("/vault");
    expect(fields.inbox).toBe("inbox.md");
    expect(fields.chat_id).toBeUndefined();
  });
});

// ── 016-engine-wiring ────────────────────────────────────────────────────

describe("SC-017: 지원 값이 단일한 노브(engine/backend/acp_version)는 위저드가 묻지 않는다", () => {
  it("engine/backend/acp_version 질문이 전혀 발생하지 않는다(무배선 노브 프롬프트 0건)", async () => {
    // 구 프롬프트는 리터럴 "engine"/"backend"/"acp_version" 문자열 질문이었다(마이그레이션 전
    // collectInteractive 구현) — 정확 일치로 그 리터럴들의 완전 소거를 확인한다(engine_args 프롬프트
    // 문구는 "engine_args (...)"로 시작해 부분일치로는 오탐하므로 정확 일치를 쓴다).
    const { ask, questions } = scriptedAsk({ source: "telegram", chat_id: "12345" });
    const opts = await collectInteractive(ask);

    expect(questions).not.toContain("engine");
    expect(questions).not.toContain("backend");
    expect(questions).not.toContain("acp_version");
    expect(opts.engine).toBeUndefined();
    expect(opts.backend).toBeUndefined();
    expect(opts.acp_version).toBeUndefined();
  });

  it("engine_args 는 옵트인 1줄 프롬프트로 남는다 — 빈 입력이면 opts 에 기록하지 않는다", async () => {
    const { ask } = scriptedAsk({ source: "telegram", chat_id: "12345" });
    const opts = await collectInteractive(ask);
    expect(opts.engine_args).toBeUndefined();
  });

  it("engine_args 입력 시 opts.engine_args 로 그대로 반영된다", async () => {
    const { ask } = scriptedAsk({
      source: "telegram",
      chat_id: "12345",
      engine_args: "--model opus",
    });
    const opts = await collectInteractive(ask);
    expect(opts.engine_args).toBe("--model opus");
  });
});
