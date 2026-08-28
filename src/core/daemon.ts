import { errMsg } from "../shared/errors.js";
import { EXIT } from "./messages.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { installCrashGuard } from "./crash-guard.js";
import type { ShutdownState } from "./crash-guard.js";
import { createCrashLoopGuard } from "./crash-loop.js";
import { defaultBase } from "../shared/paths.js";
import { writeBootReport } from "./boot-report.js";

/**
 * 포그라운드 데몬 워커 로직(v2) — `adde __daemon <proj>` 가 호출한다.
 * supervisorUp(세션 축 조립) 후 SIGTERM/SIGINT graceful shutdown 까지 포그라운드 상주.
 */
export async function runDaemonForeground(proj: string): Promise<number> {
  const { supervisorUp, supervisorDown } = await import("./supervisor.js");

  const shutdownState: ShutdownState = { active: false };
  installCrashGuard({
    onCleanup: () => supervisorDown(proj).then(() => {}),
    exit: (code) => process.exit(code),
    log: (line) => process.stderr.write(`${line}\n`),
    state: shutdownState,
  });

  const crashLoop = createCrashLoopGuard({ base: defaultBase(), proj });
  const { halt } = await crashLoop.checkOnBoot();
  if (halt) return EXIT.OK;

  const result = await supervisorUp(proj);
  await writeBootReport(defaultBase(), proj, result.sessions, undefined, result.notices).catch(
    (err: unknown) => process.stderr.write(`[boot-report] write failed: ${errMsg(err)}\n`),
  );
  process.stdout.write(`${result.message}\n`);
  for (const notice of result.notices) process.stderr.write(`${notice}\n`);

  const detached = result.sessions.filter((s) => s.status === "detached");
  for (const s of detached) {
    process.stderr.write(
      formatException({
        situation: t("run.laneStartFailed.situation", {
          lane: s.sid,
          error: t("run.unknownCause"),
        }),
        action: t("run.laneStartFailed.action", { proj, lane: s.sid }),
      }) + "\n",
    );
  }

  // 안정 판정 arm — minLifetimeMs(기본 60초) 생존 시 크래시루프 카운터 리셋.
  crashLoop.armStable();

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
            situation: t("run.shutdownError.situation", { error: errMsg(err) }),
            action: t("run.shutdownError.action"),
          }) + "\n",
        );
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // 데몬은 세션 활성 여부와 무관하게 상주한다(v2 — 세션이 0개여도 새 세션 생성을 받아야 하므로
  // v1 의 "레인 0개면 즉시 종료" 정책은 폐기한다). 종료(SIGTERM/SIGINT) 까지 resolve 하지 않는다.
  await new Promise<never>(() => {});
  return EXIT.OK; // 도달하지 않음
}
