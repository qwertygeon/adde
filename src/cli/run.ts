import { readVersion } from "../core/version.js";
import { errMsg } from "../shared/errors.js";
import { COMMANDS, buildUsage, USAGE, cmdError, flagErrorText } from "../core/messages.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { findCommand, suggestCommands } from "./spec.js";
import { parseCommand } from "./parse.js";
import { completionScript, SUPPORTED_SHELLS } from "./completion.js";
import { installCrashGuard } from "../core/crash-guard.js";
import type { ShutdownState } from "../core/crash-guard.js";
import { createCrashLoopGuard } from "../core/crash-loop.js";
import { defaultBase } from "../shared/paths.js";
import { readBootReport, writeBootReport } from "../core/boot-report.js";
import type { BootReport } from "../core/boot-report.js";

/**
 * 포그라운드 데몬 워커 로직 — `adde __daemon <proj>` 가 호출한다.
 * supervisorUp 후 SIGTERM/SIGINT graceful shutdown 까지 포그라운드 상주.
 * launchd KeepAlive 재기동 시에도 이 경로로 진입한다.
 */
async function runDaemonForeground(proj: string): Promise<number> {
  const { supervisorUp, supervisorDown } = await import("../core/supervisor.js");

  // 종료 진행 공유 플래그 — 크래시 가드(exit 1)와 정상 shutdown(exit 0)이 서로 재진입하지 않도록
  // 공유한다. 크래시 가드는 부팅 최상단에 설치해 부팅 도중 비결정적 크래시도 커버한다.
  const shutdownState: ShutdownState = { active: false };
  installCrashGuard({
    onCleanup: () => supervisorDown(proj).then(() => {}),
    exit: (code) => process.exit(code),
    log: (line) => process.stderr.write(`${line}\n`),
    state: shutdownState,
  });

  // 크래시루프 감지 — 짧은-수명 연속 사망을 이번 부팅에서 +1 집계, 임계 도달 시
  // halt 기록 후 확정 종료(exit 0)로 launchd 무한 재기동을 끊는다.
  const crashLoop = createCrashLoopGuard({ base: defaultBase(), proj });
  const { halt } = await crashLoop.checkOnBoot();
  if (halt) return 0;

  const result = await supervisorUp(proj);
  // 리포트가 유일한 판정 신호이므로 쓰기 실패를 침묵 흡수하지 않고 데몬 stderr 로 로그한다
  // (레인 기동은 계속 진행 — CLI 는 리포트 부재로 타임아웃-크래시 오판할 수 있음, 인정되는 한계).
  await writeBootReport(defaultBase(), proj, result.lanes).catch((err: unknown) =>
    process.stderr.write(`[boot-report] write failed: ${errMsg(err)}\n`),
  );
  process.stdout.write(`${result.message}\n`);

  // 기동 실패 레인은 원인 + 조치(doctor/logs)를 인라인 표면화.
  const errorLanes = result.lanes.filter((l) => l.status === "error");
  for (const l of errorLanes) {
    process.stderr.write(
      formatException({
        situation: t("run.laneStartFailed.situation", {
          lane: l.lane,
          error: l.error ?? t("run.unknownCause"),
        }),
        action: t("run.laneStartFailed.action", { proj, lane: l.lane }),
      }) + "\n",
    );
  }

  const running = result.lanes.filter((l) => l.status === "running");
  if (running.length === 0) {
    // 레인 conf 자체가 없으면 생성 단계를 안내한다.
    if (result.lanes.length === 0) {
      process.stderr.write(
        formatException({
          situation: t("run.noLanes.situation", { proj }),
          action: t("run.noLanes.action", { proj }),
        }) + "\n",
      );
    }
    // 기동된 레인이 없으면 상주할 이유가 없다 — 결정적 부팅 실패("확정 종료, 재시도 무익").
    // exit 0 전환이 표면화를 삭제하지 않는다(runtime.json status:error + up 폴링).
    return 0;
  }

  // 안정 판정 arm — minLifetimeMs(기본 60초) 생존 시 크래시루프 카운터 리셋.
  crashLoop.armStable();

  // 종료 신호 시 graceful shutdown — supervisorDown 으로 엔진 child·소스를 정리한 뒤 종료.
  // await 완료 후에만 exit(typescript 규칙: 비동기 작업이 끝나기 전에 process.exit 금지).
  const shutdown = (sig: NodeJS.Signals): void => {
    if (shutdownState.active) return;
    shutdownState.active = true;
    crashLoop.disarm();
    process.stderr.write(`\n${t("run.signalShutdown", { sig })}\n`);
    void supervisorDown(proj)
      .then((r) => {
        process.stdout.write(`${r.message}\n`);
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          formatException({
            situation: t("run.shutdownError.situation", {
              error: errMsg(err),
            }),
            action: t("run.shutdownError.action"),
          }) + "\n",
        );
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // 레인 기동 성공 → 소스 루프가 이벤트 루프를 유지하는 동안 포그라운드 상주.
  // 종료(SIGTERM/SIGINT) 까지 resolve 하지 않아 진입점의 process.exit 를 막는다.
  await new Promise<never>(() => {});
  return 0; // 도달하지 않음
}

/**
 * `bootId > baselineBootId` 인 부팅 리포트가 나타날 때까지 대기(300ms tick). up/restart 가
 * baseline 개시 이전에 읽어둔 boot id 를 넘겨, 자신이 개시한 부팅의 리포트만 소비한다
 * (strict-greater — 잔존 리포트를 이번 결과로 오인하지 않음). 상한(`waitMs`) 초과 시 null.
 */
async function waitForBootReport(
  proj: string,
  baselineBootId: number,
  waitMs: number,
  readReport: (proj: string) => Promise<BootReport | null>,
): Promise<BootReport | null> {
  const start = Date.now();
  let report = await readReport(proj);
  while (!(report && report.bootId > baselineBootId) && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 300));
    report = await readReport(proj);
  }
  return report && report.bootId > baselineBootId ? report : null;
}

/**
 * `up`/`restart` 공통 결과-표면화 경로 — 자신이 개시한 부팅(`baseline` 초과 boot id)의 리포트를
 * 대기해 실패 레인·크래시(리포트 없음)·요약을 동일하게 표면화한다. 두 명령의 차이(등록 분기/unload
 * 등 선행 단계, `upDone`/`restartDone` 완료 메시지)는 호출측이 처리하고, 이 함수는 그 이후의
 * 리포트 대기·요약·종료코드만 담당한다(중복 blocks 제거).
 */
async function surfaceStartResult(proj: string, baseline: number): Promise<number> {
  // 대기 상한(ms). 느린 머신에서 기동이 8s 이상 걸리면 ADDE_UP_WAIT_MS 로 늘릴 수 있다.
  // 양수만 유효 — 0·음수·비수치는 기본 8000(음수를 그대로 쓰면 대기를 건너뛰어 오탐을 유발).
  const waitEnv = Number(process.env.ADDE_UP_WAIT_MS);
  const waitMs = Number.isFinite(waitEnv) && waitEnv > 0 ? waitEnv : 8000;
  if (process.env.ADDE_UP_POLL_MS !== undefined) {
    process.stderr.write(t("run.pollMsDeprecated") + "\n");
  }
  const report = await waitForBootReport(proj, baseline, waitMs, (p) =>
    readBootReport(defaultBase(), p),
  );
  // 대응 리포트 미기록(타임아웃) = 부팅 크래시로 간주 — 리포트 부재를 성공으로 오인하지 않는다.
  if (report === null) {
    process.stderr.write(t("run.upInconclusive", { proj }) + "\n");
    return 1;
  }
  const failed = report.lanes.filter((l) => l.status === "error");
  if (failed.length > 0) {
    process.stderr.write(
      t("run.upFailed", {
        lanes: failed.map((f) => `${f.lane}${f.error ? ` (${f.error})` : ""}`).join(", "),
        proj,
      }) + "\n",
    );
  }
  process.stdout.write(
    t("run.upSummary", { running: report.running, failed: failed.length }) + "\n",
  );
  process.stdout.write(t("run.statusHint", { proj }) + "\n");
  return failed.length > 0 ? 1 : 0;
}

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * @returns 프로세스 종료 코드.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    process.stdout.write(`${buildUsage()}\n`);
    return 0;
  }
  const spec = findCommand(first);

  // (A) 알려진 명령이 아님 — 미지원 명령·전역 플래그 선두(위치 무관 인식).
  if (!spec) {
    const g = parseCommand({ flags: [] }, argv);
    if (g.version) {
      process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
      return 0;
    }
    if (g.help || first === "help") {
      process.stdout.write(`${buildUsage()}\n`);
      return 0;
    }
    if (g.error) {
      process.stderr.write(`${flagErrorText(g.error)}\n\n${buildUsage()}\n`);
      return 1;
    }
    // 비플래그 토큰 = 미지원 명령 → stderr 로 오류(+오타 추정 힌트) + 사용법(스크립트 오류 은폐 방지).
    const suggestions = suggestCommands(first);
    const hint =
      suggestions.length > 0 ? " " + t("cli.didYouMean", { cmds: suggestions.join(", ") }) : "";
    process.stderr.write(`${t("cli.unknownCmd", { cmd: first })}${hint}\n\n${buildUsage()}\n`);
    return 1;
  }

  // 서브커맨드별 도움말 — `adde <cmd> --help`. lane 은 runLane 이 자체 처리(하위 명령 도움말).
  if (first !== "lane" && parseCommand({ flags: [] }, argv.slice(1)).help) {
    if (spec.usageKey && !spec.hidden) {
      process.stdout.write(t(spec.usageKey as never) + "\n");
      return 0;
    }
  }

  if (first === "completion") {
    const shell = argv[1];
    if (!shell) {
      process.stderr.write(USAGE.completion + "\n");
      return 1;
    }
    const script = completionScript(shell);
    if (script === null) {
      process.stderr.write(
        cmdError(
          "completion",
          t("completion.unknownShell", { shell, supported: SUPPORTED_SHELLS.join("|") }),
        ) + "\n",
      );
      return 1;
    }
    process.stdout.write(script);
    // stdout 이 터미널이면(리다이렉트 아님) 설치 힌트를 stderr 로 — 파이프/리다이렉트 시엔 stdout 은 순수 스크립트 유지.
    if (process.stdout.isTTY) {
      process.stderr.write("\n" + t("completion.installHint", { shell }) + "\n");
    }
    return 0;
  }

  if (first === "init") {
    const { runInit } = await import("./init.js");
    return runInit(argv.slice(1));
  }

  if (first === "alias") {
    const { runAlias } = await import("./init.js");
    return runAlias(argv.slice(1));
  }

  if (first === "lane") {
    const { runLane } = await import("./lane.js");
    return runLane(argv.slice(1));
  }

  if (first === "proj") {
    const { runProj } = await import("./proj.js");
    return runProj(argv.slice(1));
  }

  // 내부 서브커맨드 — launchd 가 데몬 워커로 기동하는 포그라운드 상주 진입점.
  // 도움말 미노출(최소 표면). 사용자가 직접 부르지 않는 내부 명령.
  if (first === "__daemon") {
    const proj = argv[1];
    if (!proj) {
      process.stderr.write(t("usage.daemon") + "\n");
      return 1;
    }
    try {
      return await runDaemonForeground(proj);
    } catch (err) {
      // runDaemonForeground/supervisorUp 을 await 하다 잡힌 동기·await 부팅 예외 — 동일 입력에
      // 재현되는 결정적 실패("확정 종료, 재시도 무익")이므로 exit 0. 비결정적
      // 크래시(글로벌 uncaughtException)는 크래시 가드가 별도로 exit 1 처리한다.
      process.stderr.write(cmdError("__daemon", errMsg(err)) + "\n");
      return 0;
    }
  }

  // (C) 파싱형 top-level — up/down/restart/status/doctor/logs/sessions. 단일 parseCommand 호출로
  // 전역 버전·미지원 플래그를 처리한 뒤 파싱 결과를 각 핸들러에 전달한다.
  const res = parseCommand(spec, argv.slice(1));
  if (res.version) {
    process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
    return 0;
  }
  if (res.error) {
    const usage = spec.usageKey ? t(spec.usageKey as never) : buildUsage();
    process.stderr.write(`${cmdError(first, flagErrorText(res.error))}\n\n${usage}\n`);
    return 1;
  }

  if (first === "status") {
    const { runStatus } = await import("./ops.js");
    return runStatus(argv.slice(1), res);
  }

  if (first === "doctor") {
    const { runDoctorCli } = await import("./ops.js");
    return runDoctorCli(argv.slice(1), res);
  }

  if (first === "logs") {
    const { runLogs } = await import("./ops.js");
    return runLogs(argv.slice(1), res);
  }

  if (first === "sessions") {
    const { runSessions } = await import("./ops.js");
    return runSessions(argv.slice(1), res);
  }

  if (first === "up") {
    const proj = res.positional[0];
    if (!proj) {
      process.stderr.write(USAGE.up + "\n");
      return 1;
    }
    try {
      const { loadDaemon, daemonRegState, unloadDaemon } = await import("../core/launchd.js");
      const { collectStatus, clearHalt } = await import("../core/diagnostics.js");
      // 사용자 명령(up) = 명시적 재시도 → halt 초기화. 등록 잔존/신규 기동 분기 모두 선행.
      await clearHalt(defaultBase(), proj);
      // 이미 등록·상주 중이면 launchctl load 는 "already loaded" 로 실패한다 — 혼란스러운
      // 오류 대신 "이미 기동 중"을 명시 안내한다(실행 중 레인 수를 runtime.json 에서 읽어 표면화).
      const reg = await daemonRegState(proj);
      if (reg.launchctlRegistered) {
        const rows = await collectStatus(proj);
        const running = rows.filter((r) => r.status === "running").length;
        if (running === 0) {
          // 등록 잔존 + 상주 레인 없음(부팅-실패-잔존 포함) — alreadyUp 조기반환
          // 대신 재적재해 데드엔드를 해소한다. 아래 신규 기동과 동일한 load+poll 경로로 합류.
          process.stdout.write(t("run.deadRegistered", { proj }) + "\n");
          await unloadDaemon(proj);
        } else {
          // 이미 기동 중이어도 건강하지 않은 레인(error/dead/stale)이 있으면 표면화하고 종료코드 1.
          // 데몬이 이미 상주하므로 freshness 판별은 무의미(신규 기동 경로와 달리): 현재 상태를 그대로 보고한다.
          // stale(하트비트 끊긴 행) 도 포함 — 상주 데몬에서 가장 알려야 할 상태다(status 도 stale 을 경고).
          const unhealthy = rows.filter(
            (r) => r.status === "error" || r.status === "dead" || r.status === "stale",
          );
          process.stdout.write(t("run.alreadyUp", { proj, running, total: rows.length }) + "\n");
          if (unhealthy.length > 0) {
            process.stderr.write(
              t("run.alreadyUpUnhealthy", {
                lanes: unhealthy
                  .map((r) => `${r.lane} (${r.status}${r.error ? `: ${r.error}` : ""})`)
                  .join(", "),
                proj,
              }) + "\n",
            );
          }
          process.stdout.write(t("run.alreadyUpHint", { proj }) + "\n");
          return unhealthy.length > 0 ? 1 : 0;
        }
      }
      // baseline — 이번 부팅이 개시되기 전 리포트의 boot id. 이후 이 값보다 큰 bootId 리포트만
      // 이번 기동 결과로 소비한다(잔존 리포트를 이번 결과로 오인하지 않도록).
      const baseline = (await readBootReport(defaultBase(), proj))?.bootId ?? 0;
      await loadDaemon(proj);
      process.stdout.write(t("run.upDone", { proj }) + "\n");
      // 기동 결과를 바로 표면화 — restart 와 동일한 공유 경로(surfaceStartResult, N-1).
      return await surfaceStartResult(proj, baseline);
    } catch (err) {
      process.stderr.write(cmdError("up", errMsg(err)) + "\n");
      return 1;
    }
  }

  if (first === "down") {
    const proj = res.positional[0];
    if (!proj) {
      process.stderr.write(USAGE.down + "\n");
      return 1;
    }
    try {
      const { unloadDaemon } = await import("../core/launchd.js");
      await unloadDaemon(proj);
      process.stdout.write(t("run.downDone", { proj }) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(cmdError("down", errMsg(err)) + "\n");
      return 1;
    }
  }

  if (first === "restart") {
    const proj = res.positional[0];
    if (!proj) {
      process.stderr.write(USAGE.restart + "\n");
      return 1;
    }
    try {
      const { unloadDaemon, loadDaemon } = await import("../core/launchd.js");
      const { clearHalt } = await import("../core/diagnostics.js");
      // 사용자 명령(restart) = 명시적 재시도 → halt 초기화.
      await clearHalt(defaultBase(), proj);
      // down 완료 await 후 up — 부분 실패 시 up 오류 표면화.
      await unloadDaemon(proj);
      // baseline — up 과 동일하게 이번 부팅 개시 전 리포트의 boot id 를 읽어 이후 이보다
      // 큰 bootId 리포트만 이번 재기동 결과로 소비한다.
      const baseline = (await readBootReport(defaultBase(), proj))?.bootId ?? 0;
      await loadDaemon(proj);
      process.stdout.write(t("run.restartDone", { proj }) + "\n");
      // up 과 동일한 공유 경로(surfaceStartResult, N-1) — 재기동 성공/실패 레인을 동등하게 표면화한다.
      return await surfaceStartResult(proj, baseline);
    } catch (err) {
      process.stderr.write(cmdError("restart", errMsg(err)) + "\n");
      return 1;
    }
  }

  // 도달하지 않음(COMMAND_SPECS 의 명령 이름을 위에서 모두 처리) — 방어.
  process.stderr.write(`${buildUsage()}\n`);
  return 1;
}
