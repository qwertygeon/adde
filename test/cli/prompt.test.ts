import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createPrompter, askYesNo } from "../../src/cli/prompt.js";
import type { Ask } from "../../src/cli/prompt.js";

/** 주입한 sink 로 프롬프터 출력에 도달한 텍스트를 수집한다. */
function captureSink(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { output, text: () => chunks.join("") };
}

describe("createPrompter.askSecret (시크릿 비노출)", () => {
  it("가려진 입력은 화면(sink)에 에코되지 않고 값만 반환한다", async () => {
    const input = new PassThrough();
    const { output, text } = captureSink();
    const p = createPrompter({ input, output });

    const secretP = p.askSecret("telegram bot token");
    input.write("123:AAsecretTOKEN\n");
    const val = await secretP;
    p.close();

    expect(val).toBe("123:AAsecretTOKEN");
    const printed = text();
    expect(printed).toContain("telegram bot token:"); // 프롬프트는 표시
    expect(printed).not.toContain("secretTOKEN"); // 시크릿 본문은 에코되지 않음
  });

  it("ask(비밀 아님)는 기본값을 적용한다", async () => {
    const input = new PassThrough();
    const { output } = captureSink();
    const p = createPrompter({ input, output });

    const aP = p.ask("engine", "claude-agent-acp");
    input.write("\n"); // 빈 입력 → 기본값
    const val = await aP;
    p.close();

    expect(val).toBe("claude-agent-acp");
  });
});

describe("askYesNo (y/N 확인 프리미티브)", () => {
  /** 응답 큐를 순서대로 반환하는 ask 페이크 — 마지막 값 소진 후엔 계속 그 값을 낸다. */
  function queuedAsk(answers: string[]): {
    ask: Ask;
    seen: Array<{ q: string; def: string | undefined }>;
  } {
    const seen: Array<{ q: string; def: string | undefined }> = [];
    let i = 0;
    const ask: Ask = async (q, def) => {
      seen.push({ q, def });
      return answers[Math.min(i++, answers.length - 1)] ?? "";
    };
    return { ask, seen };
  }

  it("빈 입력은 기본값 방향을 따른다(defaultYes=true → 참, false → 거짓)", async () => {
    expect(await askYesNo(queuedAsk([""]).ask, "go?", true)).toBe(true);
    expect(await askYesNo(queuedAsk([""]).ask, "go?", false)).toBe(false);
  });

  it("y/yes(대소문자 무관)는 참, n/no 는 거짓", async () => {
    expect(await askYesNo(queuedAsk(["y"]).ask, "go?", false)).toBe(true);
    expect(await askYesNo(queuedAsk(["YES"]).ask, "go?", false)).toBe(true);
    expect(await askYesNo(queuedAsk(["n"]).ask, "go?", true)).toBe(false);
    expect(await askYesNo(queuedAsk(["No"]).ask, "go?", true)).toBe(false);
  });

  it("무효 응답은 유효 응답이 올 때까지 재질의한다", async () => {
    const { ask, seen } = queuedAsk(["maybe", "huh", "y"]);
    expect(await askYesNo(ask, "go?", false)).toBe(true);
    expect(seen.length).toBe(3);
  });

  it('기본값 방향에 맞는 (Y/n)/(y/N) 접미를 스스로 붙이고 [def] 이중표기를 피한다(def="")', async () => {
    const yes = queuedAsk([""]);
    await askYesNo(yes.ask, "install?", true);
    expect(yes.seen[0]?.q).toBe("install? (Y/n)");
    expect(yes.seen[0]?.def).toBe("");

    const no = queuedAsk([""]);
    await askYesNo(no.ask, "apply?", false);
    expect(no.seen[0]?.q).toBe("apply? (y/N)");
    expect(no.seen[0]?.def).toBe("");
  });
});
