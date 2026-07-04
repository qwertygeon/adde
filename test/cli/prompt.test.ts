import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createPrompter } from "../../src/cli/prompt.js";

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

    const aP = p.ask("engine", "claude-code-acp");
    input.write("\n"); // 빈 입력 → 기본값
    const val = await aP;
    p.close();

    expect(val).toBe("claude-code-acp");
  });
});
