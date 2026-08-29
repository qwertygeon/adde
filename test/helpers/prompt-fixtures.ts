/**
 * 006(D017) — 대화형 CLI(`session rm`·`factory-reset`) 통합 테스트가 공유하는 프롬프트 더블.
 * `captureSink` 는 test/cli/prompt.test.ts 의 로컬 헬퍼를 그대로 재사용 가능한 형태로 승격했다
 * (Test Authoring Contract "대화형 경로는 createPrompter({input,output}) 주입으로 구동" 선례).
 * `queuedLineInput` 은 PassThrough 에 순서대로 줄을 흘려보내 `askChoice`/`askPhrase`/`askYesNo`
 * 등 readline 기반 질의를 실제로 관통시킨다(더블이되 no-op 이 아니라 실 스트림·실 readline 경유).
 */
import { PassThrough, Writable } from "node:stream";

export function captureSink(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { output, text: () => chunks.join("") };
}

type Ask = (question: string, defaultValue?: string) => Promise<string>;

/**
 * (test(EXECUTION) 수정 — [B] 픽스처 결함) `node:readline/promises` 의 `Interface.question()` 은
 * 호출 시점에 **동기적으로** `once('line', …)` 리스너를 건다. 이전 구현은 프롬프터 생성 직후
 * `setImmediate` 로 즉시 줄을 흘려보냈는데, 호출부가 `askChoice` 를 부르기 전에 실제 CLI 작업
 * (`planSessionRemoval`·`buildResetInventory` 등 fs I/O)을 먼저 수행하면 그 지연 동안 리스너가
 * 아직 없는 상태로 줄이 도착해 `line` 이벤트가 유실된다(이후 재입력이 없어 무기한 hang — 실측:
 * `session-rm-3way.test.ts`·`factory-reset.test.ts` 전건 타임아웃). 고정 지연으로는 근본 해결이
 * 안 되므로(작업 시간이 가변) `arm()` 이 `prompter.ask` 를 감싸 **`ask()` 호출 시점**(= 리스너
 * 등록 시점과 동기)에 맞춰 다음 줄을 쓴다 — 타이밍 추정이 아니라 실제 호출 이벤트에 동기화.
 */
export function queuedLineInput(lines: readonly string[]): {
  stream: PassThrough;
  arm: (prompter: { ask: Ask }) => void;
} {
  const stream = new PassThrough();
  let i = 0;
  return {
    stream,
    arm(prompter) {
      const original = prompter.ask;
      prompter.ask = ((question, defaultValue) => {
        const pending = original(question, defaultValue);
        if (i < lines.length) stream.write(`${lines[i++]}\n`);
        return pending;
      }) as Ask;
    },
  };
}
