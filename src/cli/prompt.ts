/**
 * 대화형 프롬프트 — readline 기반 질의(ask)와 가려진 입력(askSecret).
 * askSecret 은 출력 스트림을 일시 뮤트해 봇 토큰 등 시크릿이 화면에 에코되지 않게 한다
 * (시크릿 비노출 원칙 — transcript·화면 평문 노출 금지).
 */
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import * as fs from "node:fs";
import { dirname, basename, join } from "node:path";
import { expandTilde, normalizeUserPath } from "../shared/paths.js";

/**
 * 경로 입력용 Tab 완성기 — cwd/root/inbox 등 경로 프롬프트에서 디렉터리·파일명을 완성한다.
 * 현재 입력의 상위 디렉터리를 스캔해 접두사 매칭 후보를 반환(디렉터리는 끝에 `/`).
 * 경로가 아닌 프롬프트에서 Tab 을 눌러도 매칭이 없으면 무동작이라 해가 없다.
 */
function pathCompleter(line: string): [string[], string] {
  try {
    const expanded = expandTilde(line.trim());
    const endsSlash = expanded.endsWith("/");
    const dir = endsSlash ? expanded : dirname(expanded) || ".";
    const prefix = endsSlash ? "" : basename(expanded);
    const matches = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(prefix))
      .map((e) => join(dir, e.name) + (e.isDirectory() ? "/" : ""));
    return [matches, line];
  } catch {
    return [[], line];
  }
}

/** 한 줄 질의 함수 — (질문, 기본값) → 응답. */
export type Ask = (question: string, def?: string) => Promise<string>;

/**
 * y/N 확인 프롬프트 — 기본값 방향에 맞는 `(Y/n)`/`(y/N)` 접미를 스스로 붙인다. 빈 입력=기본값,
 * `y[es]`=참, `n[o]`=거짓으로 매핑하고, 그 외 무효 입력은 기본값으로 흡수하지 않고 유효 응답이 올 때까지
 * 재질의한다(`askEnum` 과 동일 관례 — 오타가 조용히 아니오/취소로 처리되는 것을 방지). question 은 접미·기본값 표기를 포함하지 않은 순수 문구로
 * 준다 — 라벨의 `(y/N)` 하드코딩과 `[def]` 이중 표기, 기본값 방향 모순을 프리미티브 한 곳으로 일원화한다.
 * i18n 비의존(문구는 호출부가 번역해 전달). def 를 "" 로 넘겨 `[def]` 이중 표기를 피한다.
 */
export async function askYesNo(ask: Ask, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " (Y/n)" : " (y/N)";
  for (;;) {
    const raw = (await ask(`${question}${suffix}`, "")).trim().toLowerCase();
    if (raw === "") return defaultYes;
    if (/^y(es)?$/.test(raw)) return true;
    if (/^n(o)?$/.test(raw)) return false;
  }
}

export interface Prompter {
  ask: Ask;
  /** 경로 입력용 질의 — 이 호출 동안만 Tab 디렉터리/파일 완성을 켠다(cwd/root/inbox 등). */
  askPath: Ask;
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
  // 경로 완성은 askPath 호출 동안만 켠다 — enum·y/N·확인·시크릿 등 비-경로 프롬프트에서
  // Tab 이 경로를 삽입해 필드를 오염시키거나(가려진 토큰 입력 포함) 하지 않도록 스코프를 좁힌다.
  let pathMode = false;
  const rl = readline.createInterface({
    input,
    output: out,
    terminal: true,
    completer: (line: string): [string[], string] => (pathMode ? pathCompleter(line) : [[], line]),
  });

  const question = async (q: string, def?: string): Promise<string> => {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || (def ?? "");
  };

  const ask: Ask = (q, def) => question(q, def);

  const askPath: Ask = async (q, def) => {
    pathMode = true;
    try {
      return normalizeUserPath(await question(q, def));
    } finally {
      pathMode = false;
    }
  };

  const askSecret = async (q: string): Promise<string> => {
    // 프롬프트는 뮤트 전에 출력하고, 입력 구간만 뮤트해 에코를 억제. pathMode 는 false 라 완성 비활성.
    sink.write(`${q}: `);
    muted = true;
    try {
      const a = await rl.question("");
      return a.trim();
    } finally {
      muted = false;
      sink.write("\n");
    }
  };

  return { ask, askPath, askSecret, close: () => rl.close() };
}
