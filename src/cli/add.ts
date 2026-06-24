#!/usr/bin/env node
// `add` 는 `adde` 의 단축 별칭 — 동일 진입 로직을 공유한다(A-P005).
import { run } from "./run.js";

process.exit(run(process.argv.slice(2)));
