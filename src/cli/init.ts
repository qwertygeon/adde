/**
 * `adde init [proj]` — 신규 사용자 온보딩 위저드(v2).
 * 환경 점검(doctor) → 짧은 별칭 설치(옵트인) → 대화형 프로젝트 생성(vault 경로 필수 질의) →
 * 기동 안내를 한 흐름으로 묶어 첫 설정 마찰을 줄인다.
 * `adde alias [names...]` — 별칭만 따로 설치하는 경량 진입점(재실행용).
 */
import { t } from "../shared/i18n.js";
import { formatException } from "../shared/notify.js";
import { runDoctor } from "../core/diagnostics.js";
import { checkSymbol } from "./ops.js";
import { createPrompter, askYesNo } from "./prompt.js";
import { cmdError } from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { RECOMMENDED_ALIASES, setupAliases, resolveAliasDeps } from "./alias.js";
import type { AliasSetupResult } from "./alias.js";

/** proj 식별자 — 경로 세그먼트 안전 문자셋. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function detectShell(): "bash" | "zsh" | null {
  const sh = process.env["SHELL"] ?? "";
  if (sh === "zsh" || sh.endsWith("/zsh")) return "zsh";
  if (sh === "bash" || sh.endsWith("/bash")) return "bash";
  return null;
}

function printAliasResult(result: AliasSetupResult, binDir: string): void {
  for (const n of result.created)
    process.stdout.write(t("init.aliasCreated", { name: n, dir: binDir }) + "\n");
  for (const n of result.alreadyLinked)
    process.stdout.write(t("init.aliasAlready", { name: n }) + "\n");
  for (const s of result.skipped) {
    process.stdout.write(
      (s.reason === "error"
        ? t("init.aliasFailed", { name: s.name, detail: s.detail ?? "" })
        : t("init.aliasSkipped", { name: s.name })) + "\n",
    );
  }
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

    const checks = await runDoctor();
    for (const c of checks) {
      process.stdout.write(`  ${checkSymbol(c.level)} ${c.name}: ${c.detail}\n`);
      if (c.hint && (c.level === "FAIL" || c.level === "WARN")) {
        process.stdout.write(t("ops.doctor.hint", { hint: c.hint }) + "\n");
      }
    }
    if (checks.some((c) => c.level === "FAIL"))
      process.stdout.write("\n" + t("init.doctorWarn") + "\n");
    process.stdout.write("\n");

    if (
      await askYesNo(ask, t("init.aliasPrompt", { names: RECOMMENDED_ALIASES.join(", ") }), true)
    ) {
      const deps = await resolveAliasDeps();
      if (!deps) process.stdout.write(t("init.aliasNoBin") + "\n");
      else printAliasResult(await setupAliases(RECOMMENDED_ALIASES, deps), deps.binDir);
    }
    process.stdout.write("\n");

    const shell = detectShell();
    if (shell) {
      if (await askYesNo(ask, t("init.completionPrompt", { shell }), true)) {
        process.stdout.write(t("init.completionWhat") + "\n");
        process.stdout.write(
          t(shell === "zsh" ? "init.completionZsh" : "init.completionBash") + "\n",
        );
      }
      process.stdout.write("\n");
    }

    // 프로젝트 생성(대화형) — vault 경로는 필수(FR-028, 기본 경로 자동 생성 없음).
    let proj = projArg ?? (await ask(t("init.projPrompt"), "default"));
    while (!NAME_RE.test(proj)) proj = await ask(t("init.projRetry"), "default");
    let vault = await ask("마크다운 저장소(vault) 루트 절대경로: ", "");
    while (vault.trim().length === 0) vault = await ask("vault 경로는 필수입니다. 다시 입력: ", "");

    const { runProject } = await import("./project.js");
    const code = await runProject(["add", proj, "--vault", vault]);
    if (code !== 0) return code;

    process.stdout.write("\n" + t("init.done", { proj }) + "\n");
    process.stdout.write(`다음 명령으로 데몬을 기동하세요: adde up ${proj}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(cmdError("init", errMsg(err)) + "\n");
    return 1;
  } finally {
    prompter.close();
  }
}

/** `adde alias [names...]` — 짧은 별칭만 설치(기본 ad·add). 비대화형. */
export async function runAlias(argv: readonly string[]): Promise<number> {
  try {
    const names = argv.filter((a) => !a.startsWith("--"));
    const chosen = names.length > 0 ? names : [...RECOMMENDED_ALIASES];
    const deps = await resolveAliasDeps();
    if (!deps) {
      process.stderr.write(t("init.aliasNoBin") + "\n");
      return 1;
    }
    const result = await setupAliases(chosen, deps);
    printAliasResult(result, deps.binDir);
    const progressed = result.created.length > 0 || result.alreadyLinked.length > 0;
    return progressed || result.skipped.length === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(cmdError("alias", errMsg(err)) + "\n");
    return 1;
  }
}
