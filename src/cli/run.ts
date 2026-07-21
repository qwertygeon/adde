import { readVersion } from "../core/version.js";
import { errMsg } from "../shared/errors.js";
import { COMMANDS, buildUsage, USAGE, cmdError, flagErrorText, EXIT } from "../core/messages.js";
import { t } from "../shared/i18n.js";
import { findCommand, suggestCommands } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";
import { completionScript, SUPPORTED_SHELLS } from "./completion.js";
import { defaultBase } from "../shared/paths.js";
import { readBootReport } from "../core/boot-report.js";
import type { BootReport } from "../core/boot-report.js";

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
 * `json=true` 시 사람용 텍스트(요약·힌트)를 억제하고 BootReport(또는 리포트 부재 시 `null`)를
 * 그대로 stdout 에 직렬화한다(신규 계산·필드 없음 — 기존 산출 재사용). 종료코드 판정은 텍스트 모드와 동일.
 */
async function surfaceStartResult(proj: string, baseline: number, json = false): Promise<number> {
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
    if (json) {
      process.stdout.write(JSON.stringify(null) + "\n");
    } else {
      process.stderr.write(t("run.upInconclusive", { proj }) + "\n");
    }
    return EXIT.FAIL;
  }
  const failed = report.lanes.filter((l) => l.status === "error");
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return failed.length > 0 ? EXIT.FAIL : EXIT.OK;
  }
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
  return failed.length > 0 ? EXIT.FAIL : EXIT.OK;
}

/** pre-parse 핸들러 — `completion <shell>`. 잔여 argv(`rest`)를 자체 파싱한다. */
async function handleCompletion(rest: readonly string[]): Promise<number> {
  const shell = rest[0];
  if (!shell) {
    process.stderr.write(USAGE.completion + "\n");
    return EXIT.USAGE;
  }
  const script = completionScript(shell);
  if (script === null) {
    process.stderr.write(
      cmdError(
        "completion",
        t("completion.unknownShell", { shell, supported: SUPPORTED_SHELLS.join("|") }),
      ) + "\n",
    );
    return EXIT.FAIL;
  }
  process.stdout.write(script);
  // stdout 이 터미널이면(리다이렉트 아님) 설치 힌트를 stderr 로 — 파이프/리다이렉트 시엔 stdout 은 순수 스크립트 유지.
  if (process.stdout.isTTY) {
    process.stderr.write("\n" + t("completion.installHint", { shell }) + "\n");
  }
  return EXIT.OK;
}

/**
 * pre-parse 핸들러 — 내부 서브커맨드 `__daemon <proj>`. launchd 가 데몬 워커로 기동하는
 * 포그라운드 상주 진입점(도움말 미노출, 사용자가 직접 부르지 않는 내부 명령)으로의 얇은 위임.
 */
async function handleDaemon(rest: readonly string[]): Promise<number> {
  const proj = rest[0];
  if (!proj) {
    process.stderr.write(t("usage.daemon") + "\n");
    return EXIT.USAGE;
  }
  try {
    const { runDaemonForeground } = await import("../core/daemon.js");
    return await runDaemonForeground(proj);
  } catch (err) {
    // runDaemonForeground/supervisorUp 을 await 하다 잡힌 동기·await 부팅 예외 — 동일 입력에
    // 재현되는 결정적 실패("확정 종료, 재시도 무익")이므로 exit 0. 비결정적
    // 크래시(글로벌 uncaughtException)는 크래시 가드가 별도로 exit 1 처리한다.
    process.stderr.write(cmdError("__daemon", errMsg(err)) + "\n");
    return EXIT.OK;
  }
}

/** post-parse 핸들러 — `up <proj>`. run() 이 선처리한 `parsed` 를 수신한다(parse:true 그룹 — 항상 전달됨). */
async function handleUp(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const res = parsed as ParseResult;
  const proj = res.positional[0];
  if (!proj) {
    process.stderr.write(USAGE.up + "\n");
    return EXIT.USAGE;
  }
  const json = res.flags.json === true;
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
        // 대신 재적재해 데드엔드를 해소한다. 아래 신규 기동과 동일한 load+poll 경로로 합류(--json 은
        // surfaceStartResult 가 처리 — 여기 안내 텍스트만 억제).
        if (!json) process.stdout.write(t("run.deadRegistered", { proj }) + "\n");
        await unloadDaemon(proj);
      } else {
        // 이미 기동 중이어도 건강하지 않은 레인(error/dead/stale)이 있으면 표면화하고 종료코드 1.
        // 데몬이 이미 상주하므로 freshness 판별은 무의미(신규 기동 경로와 달리): 현재 상태를 그대로 보고한다.
        // stale(하트비트 끊긴 행) 도 포함 — 상주 데몬에서 가장 알려야 할 상태다(status 도 stale 을 경고).
        const unhealthy = rows.filter(
          (r) => r.status === "error" || r.status === "dead" || r.status === "stale",
        );
        // 비정상 레인 경고는 조언성 스트림 — --json 여부와 무관하게 stderr 유지.
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
        // 부팅을 개시하지 않은 조기반환 — BootReport 가 없으므로 현재 상태 요약 객체로 대체.
        if (json) {
          process.stdout.write(
            JSON.stringify({ v: 1, proj, alreadyUp: true, running }, null, 2) + "\n",
          );
        } else {
          process.stdout.write(t("run.alreadyUp", { proj, running, total: rows.length }) + "\n");
          process.stdout.write(t("run.alreadyUpHint", { proj }) + "\n");
        }
        return unhealthy.length > 0 ? EXIT.FAIL : EXIT.OK;
      }
    }
    // baseline — 이번 부팅이 개시되기 전 리포트의 boot id. 이후 이 값보다 큰 bootId 리포트만
    // 이번 기동 결과로 소비한다(잔존 리포트를 이번 결과로 오인하지 않도록).
    const baseline = (await readBootReport(defaultBase(), proj))?.bootId ?? 0;
    await loadDaemon(proj);
    if (!json) process.stdout.write(t("run.upDone", { proj }) + "\n");
    // 기동 결과를 바로 표면화 — restart 와 동일한 공유 경로(surfaceStartResult, N-1).
    return await surfaceStartResult(proj, baseline, json);
  } catch (err) {
    process.stderr.write(cmdError("up", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}

/** post-parse 핸들러 — `down <proj>`. run() 이 선처리한 `parsed` 를 수신한다(parse:true 그룹 — 항상 전달됨). */
async function handleDown(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const res = parsed as ParseResult;
  const proj = res.positional[0];
  if (!proj) {
    process.stderr.write(USAGE.down + "\n");
    return EXIT.USAGE;
  }
  const json = res.flags.json === true;
  try {
    const { unloadDaemon, daemonRegState } = await import("../core/launchd.js");
    // 등록/상주 여부를 unload 전에 확인 — 미등록·오타 proj 에 무조건 "stopped" 성공을 보고해
    // 오타를 은폐하지 않도록 구분 안내한다(unload 는 멱등이라 그 자체로는 상태를 알려주지 못한다).
    const reg = await daemonRegState(proj);
    const wasRegistered = reg.plistExists || reg.launchctlRegistered;
    await unloadDaemon(proj);
    if (json) {
      process.stdout.write(
        JSON.stringify({ v: 1, proj, stopped: true, wasRegistered }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(
        t(wasRegistered ? "run.downDone" : "run.downNotRunning", { proj }) + "\n",
      );
    }
    return EXIT.OK;
  } catch (err) {
    // --json 이어도 오류는 stderr — 금지 대상은 stdout 본문 오염뿐이므로 stdout 은 비워둔다.
    process.stderr.write(cmdError("down", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}

/** post-parse 핸들러 — `restart <proj>`. run() 이 선처리한 `parsed` 를 수신한다(parse:true 그룹 — 항상 전달됨). */
async function handleRestart(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const res = parsed as ParseResult;
  const proj = res.positional[0];
  if (!proj) {
    process.stderr.write(USAGE.restart + "\n");
    return EXIT.USAGE;
  }
  const json = res.flags.json === true;
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
    if (!json) process.stdout.write(t("run.restartDone", { proj }) + "\n");
    // up 과 동일한 공유 경로(surfaceStartResult, N-1) — 재기동 성공/실패 레인을 동등하게 표면화한다.
    return await surfaceStartResult(proj, baseline, json);
  } catch (err) {
    process.stderr.write(cmdError("restart", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}

/** 명령 핸들러 시그니처 — pre-parse 그룹은 `parsed` 를 무시하고, post-parse 그룹은 run() 이 선처리한 결과를 수신한다. */
type CommandHandler = (rest: readonly string[], parsed?: ParseResult) => Promise<number>;

/**
 * `COMMAND_SPECS` 이름 → 핸들러 참조 테이블(SSOT 파생 디스패치). 키 집합은 `COMMAND_SPECS` 의
 * 이름 집합과 정확히 일치해야 한다(드리프트 가드 — 파리티 테스트가 런타임 집합 동등성으로 강제하므로
 * export 한다). 기존 위임 핸들러(init/alias/lane/proj/status/doctor/logs/sessions)는 lazy `import()`
 * 래퍼로 참조해 현행 동적 import 를 유지한다(startup 비용 불변).
 * `parse: false` = 핸들러가 잔여 argv 를 자체 파싱(pre-parse), `parse: true` = run() 이 공유
 * `parseCommand` 로 전역 버전·오류를 선처리한 뒤 파싱 결과를 핸들러에 전달(post-parse).
 */
export const DISPATCH: Record<string, { run: CommandHandler; parse: boolean }> = {
  completion: { run: handleCompletion, parse: false },
  init: { run: async (rest) => (await import("./init.js")).runInit(rest), parse: false },
  alias: { run: async (rest) => (await import("./init.js")).runAlias(rest), parse: false },
  lane: { run: async (rest) => (await import("./lane.js")).runLane(rest), parse: false },
  proj: { run: async (rest) => (await import("./proj.js")).runProj(rest), parse: false },
  __daemon: { run: handleDaemon, parse: false },
  status: {
    run: async (rest, parsed) => (await import("./ops.js")).runStatus(rest, parsed),
    parse: true,
  },
  doctor: {
    run: async (rest, parsed) => (await import("./ops.js")).runDoctorCli(rest, parsed),
    parse: true,
  },
  logs: {
    run: async (rest, parsed) => (await import("./ops.js")).runLogs(rest, parsed),
    parse: true,
  },
  sessions: {
    run: async (rest, parsed) => (await import("./ops.js")).runSessions(rest, parsed),
    parse: true,
  },
  up: { run: handleUp, parse: true },
  down: { run: handleDown, parse: true },
  restart: { run: handleRestart, parse: true },
};

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * @returns 프로세스 종료 코드.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    process.stdout.write(`${buildUsage()}\n`);
    return EXIT.OK;
  }
  const spec = findCommand(first);

  // (A) 알려진 명령이 아님 — 미지원 명령·전역 플래그 선두(위치 무관 인식).
  if (!spec) {
    const g = parseCommand({ flags: [] }, argv);
    if (g.version) {
      process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
      return EXIT.OK;
    }
    if (g.help || first === "help") {
      process.stdout.write(`${buildUsage()}\n`);
      return EXIT.OK;
    }
    if (g.error) {
      process.stderr.write(`${flagErrorText(g.error)}\n\n${buildUsage()}\n`);
      return EXIT.USAGE;
    }
    // 비플래그 토큰 = 미지원 명령 → stderr 로 오류(+오타 추정 힌트) + 사용법(스크립트 오류 은폐 방지).
    const suggestions = suggestCommands(first);
    const hint =
      suggestions.length > 0 ? " " + t("cli.didYouMean", { cmds: suggestions.join(", ") }) : "";
    process.stderr.write(`${t("cli.unknownCmd", { cmd: first })}${hint}\n\n${buildUsage()}\n`);
    return EXIT.FAIL;
  }

  // 서브커맨드별 도움말 — `adde <cmd> --help`. lane 은 runLane 이 자체 처리(하위 명령 도움말).
  if (first !== "lane" && parseCommand({ flags: [] }, argv.slice(1)).help) {
    if (spec.usageKey && !spec.hidden) {
      process.stdout.write(t(spec.usageKey as never) + "\n");
      return EXIT.OK;
    }
  }

  // `COMMAND_SPECS` 이름 → 핸들러 테이블 조회 디스패치. 파리티 테스트가 DISPATCH 키
  // 집합과 COMMAND_SPECS 이름 집합의 일치를 강제하므로 정상 입력에서 entry 는 항상 존재한다.
  const entry = DISPATCH[spec.name];
  if (!entry) {
    // 도달하지 않음(COMMAND_SPECS 의 명령 이름을 DISPATCH 가 모두 커버) — 방어.
    process.stderr.write(`${buildUsage()}\n`);
    return EXIT.FAIL;
  }
  const rest = argv.slice(1);
  if (entry.parse) {
    // post-parse 그룹 — 단일 parseCommand 호출로 전역 버전·미지원 플래그를 처리한 뒤
    // 파싱 결과를 핸들러에 전달한다.
    const res = parseCommand(spec, rest);
    if (res.version) {
      process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
      return EXIT.OK;
    }
    if (res.error) {
      const usage = spec.usageKey ? t(spec.usageKey as never) : buildUsage();
      process.stderr.write(`${cmdError(first, flagErrorText(res.error))}\n\n${usage}\n`);
      return EXIT.USAGE;
    }
    return entry.run(rest, res);
  }
  // pre-parse 그룹 — 핸들러가 잔여 argv 를 자체 파싱한다.
  return entry.run(rest);
}
