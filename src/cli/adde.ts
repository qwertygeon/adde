#!/usr/bin/env node
import { run } from "./run.js";

void Promise.resolve(run(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // 최후 방어선 — dispatch 에서 예기치 못한 예외가 전파되면 스택트레이스 대신 한 줄로 알리고
    // 비정상 종료한다(unhandled rejection 으로 인한 프로세스 강제 종료 방지).
    process.stderr.write(`adde: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
