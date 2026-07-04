/**
 * 대화형 프롬프트 — readline 기반 질의(ask)와 가려진 입력(askSecret).
 * askSecret 은 출력 스트림을 일시 뮤트해 봇 토큰 등 시크릿이 화면에 에코되지 않게 한다
 * (시크릿 비노출 원칙 — transcript·화면 평문 노출 금지).
 */
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";

/** 한 줄 질의 함수 — (질문, 기본값) → 응답. */
export type Ask = (question: string, def?: string) => Promise<string>;

export interface Prompter {
  ask: Ask;
  /** 가려진 입력(에코 억제) — 봇 토큰 등 시크릿 수집용. 기본값 없음. */
  askSecret: (question: string) => Promise<string>;
  close: () => void;
}

/** 주입 가능한 입출력(테스트용). 미지정 시 process.stdin/stdout. */
export interface PrompterDeps {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** process.stdin/stdout 에 붙는 대화형 프롬프터를 만든다(TTY 에서 사용). */
export function createPrompter(deps: PrompterDeps = {}): Prompter {
  const input = deps.input ?? process.stdin;
  const sink = deps.output ?? process.stdout;
  let muted = false;
  // 뮤트 가능 출력 — askSecret 동안 readline 의 키 에코를 삼킨다.
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) sink.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input, output: out, terminal: true });

  const ask: Ask = async (question, def) => {
    const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
    return a || (def ?? "");
  };

  const askSecret = async (question: string): Promise<string> => {
    // 프롬프트는 뮤트 전에 출력하고, 입력 구간만 뮤트해 에코를 억제.
    sink.write(`${question}: `);
    muted = true;
    try {
      const a = await rl.question("");
      return a.trim();
    } finally {
      muted = false;
      sink.write("\n");
    }
  };

  return { ask, askSecret, close: () => rl.close() };
}
