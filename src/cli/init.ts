/**
 * `adde init [proj]` — 신규 사용자 온보딩 위저드.
 * 환경 점검(doctor) → 짧은 별칭 설치(옵트인) → 대화형 레인 생성 → 토큰·기동 안내를
 * 한 흐름으로 묶어 첫 설정 마찰을 줄인다. 시크릿 비노출: 토큰은 여기서 받지 않고
 * 생성 후 .env/--token-stdin 안내로 위임한다(collectInteractive 와 동일 원칙).
 * `adde alias [names...]` — 별칭만 따로 설치하는 경량 진입점(재실행용).
 */
import { t } from "../shared/i18n.js";
import { formatException } from "../shared/notify.js";
import { runDoctor } from "../core/diagnostics.js";
import { laneAdd, LaneConfigError } from "../core/lane-config.js";
import { collectInteractive } from "./lane.js";
import { createPrompter } from "./prompt.js";
import { laneError } from "../core/messages.js";
import { RECOMMENDED_ALIASES, setupAliases, resolveAliasDeps } from "./alias.js";
import type { AliasSetupResult } from "./alias.js";

/** proj/lane 식별자 — 경로 세그먼트 안전 문자셋(lane-config NAME_RE 와 동일 규약). */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** $SHELL 로 사용자 셸 추정(bash|zsh). 그 외·미상은 null — 자동완성 안내를 건너뛴다. */
function detectShell(): "bash" | "zsh" | null {
  const sh = process.env["SHELL"] ?? "";
  if (sh === "zsh" || sh.endsWith("/zsh")) return "zsh";
  if (sh === "bash" || sh.endsWith("/bash")) return "bash";
  return null;
}

/** 별칭 설치 결과를 stdout 에 표면화(init·alias 공용). */
function printAliasResult(result: AliasSetupResult, binDir: string): void {
  for (const n of result.created)
    process.stdout.write(t("init.aliasCreated", { name: n, dir: binDir }) + "\n");
  for (const n of result.alreadyLinked)
    process.stdout.write(t("init.aliasAlready", { name: n }) + "\n");
  for (const s of result.skipped)
    process.stdout.write(
      (s.reason === "error"
        ? t("init.aliasFailed", { name: s.name, detail: s.detail ?? "" })
        : t("init.aliasSkipped", { name: s.name })) + "\n",
    );
}

export async function runInit(argv: readonly string[]): Promise<number> {
  const projArg = argv.find((a) => !a.startsWith("--"));
  if (!process.stdin.isTTY) {
    process.stderr.write(
      formatException({
        situation: t("init.ttyOnly.situation"),
        action: t("init.ttyOnly.action"),
      }) + "\n",
    );
    return 1;
  }
  const prompter = createPrompter();
  const ask = prompter.ask;
  try {
    process.stdout.write(t("init.intro") + "\n\n");

    // 1) 환경 점검(전역 doctor) — 결과 요약 후 FAIL 이 있으면 주의 안내(계속 진행).
    const checks = await runDoctor();
    for (const c of checks) {
      const sym = c.level === "PASS" ? "✔" : c.level === "WARN" ? "▲" : "✘";
      process.stdout.write(`  ${sym} ${c.name}: ${c.detail}\n`);
    }
    if (checks.some((c) => c.level === "FAIL")) {
      process.stdout.write("\n" + t("init.doctorWarn") + "\n");
    }
    process.stdout.write("\n");

    // 2) 짧은 별칭 설치(옵트인) — PATH 충돌은 실패로 표면화.
    const wantAlias = (
      await ask(t("init.aliasPrompt", { names: RECOMMENDED_ALIASES.join(", ") }), "y")
    ).toLowerCase();
    if (wantAlias === "y" || wantAlias === "yes") {
      const deps = await resolveAliasDeps();
      if (!deps) {
        process.stdout.write(t("init.aliasNoBin") + "\n");
      } else {
        printAliasResult(await setupAliases(RECOMMENDED_ALIASES, deps), deps.binDir);
      }
    }
    process.stdout.write("\n");

    // 2.5) 셸 탭 자동완성 설정 안내(옵트인) — 감지된 셸에 맞는 설치 명령을 출력한다.
    // 파일을 대신 쓰지 않고 실행할 명령을 안내한다(셸 rc/fpath 자동 수정은 위험 — 사용자가 직접 실행).
    const shell = detectShell();
    if (shell) {
      const wantComp = (await ask(t("init.completionPrompt", { shell }), "y")).toLowerCase();
      if (wantComp === "y" || wantComp === "yes") {
        process.stdout.write(t("init.completionWhat") + "\n");
        process.stdout.write(
          t(shell === "zsh" ? "init.completionZsh" : "init.completionBash") + "\n",
        );
      }
      process.stdout.write("\n");
    }

    // 3) 레인 생성(대화형) — proj/lane 이름을 먼저 검증(잘못되면 재질의)한 뒤 필드 수집.
    let proj = projArg ?? (await ask(t("init.projPrompt"), "default"));
    while (!NAME_RE.test(proj)) proj = await ask(t("init.projRetry"), "default");
    let lane = await ask(t("init.lanePrompt"), "main");
    while (!NAME_RE.test(lane)) lane = await ask(t("init.laneRetry"), "main");

    const opts = await collectInteractive(ask, prompter.askSecret);
    const result = await laneAdd(proj, lane, opts);
    for (const w of result.warnings) process.stdout.write(w + "\n");
    process.stdout.write(
      t("lane.created", { lane: result.lane, confPath: result.confPath }) + "\n",
    );
    if (result.envPath) {
      process.stdout.write(t("lane.tokenWritten", { envPath: result.envPath }) + "\n");
    } else if (result.conf.source === "telegram") {
      process.stdout.write(
        t("lane.tokenNext", {
          envPath: result.confPath.replace(/lanes\.d\/.*$/, `state/${result.lane}/.env`),
        }) + "\n",
      );
    }
    process.stdout.write("\n" + t("init.done", { proj }) + "\n");
    process.stdout.write(t("lane.startHint", { proj }) + "\n");
    return 0;
  } catch (err) {
    if (err instanceof LaneConfigError) {
      process.stderr.write(laneError(err.message) + "\n");
      return 1;
    }
    throw err;
  } finally {
    prompter.close();
  }
}

/** `adde alias [names...]` — 짧은 별칭만 설치(기본 ad·add). 비대화형. */
export async function runAlias(argv: readonly string[]): Promise<number> {
  const names = argv.filter((a) => !a.startsWith("--"));
  const chosen = names.length > 0 ? names : [...RECOMMENDED_ALIASES];
  const deps = await resolveAliasDeps();
  if (!deps) {
    process.stderr.write(t("init.aliasNoBin") + "\n");
    return 1;
  }
  const result = await setupAliases(chosen, deps);
  printAliasResult(result, deps.binDir);
  // 아무것도 설치/기존확인되지 않고 전부 실패면 비정상 종료(충돌 등).
  const progressed = result.created.length > 0 || result.alreadyLinked.length > 0;
  return progressed || result.skipped.length === 0 ? 0 : 1;
}
