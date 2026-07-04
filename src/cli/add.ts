#!/usr/bin/env node
// `add` 는 `adde` 의 단축 별칭 — 동일 진입 로직을 공유한다.
import { run } from "./run.js";

void Promise.resolve(run(process.argv.slice(2))).then((code) => process.exit(code));
