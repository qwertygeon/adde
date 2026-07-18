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
 * 포그라운드 데몬 워커 로직 — `adde __daemon <proj>` 가 호출한다.
 * supervisorUp 후 SIGTERM/SIGINT graceful shutdown 까지 포그라운드 상주.
 * launchd KeepAlive 재기동 시에도 이 경로로 진입한다.
 */
export async function runDaemonForeground(proj: string): Promise<number> {
  const { supervisorUp, supervisorDown } = await import("./supervisor.js");

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
  if (halt) return EXIT.OK;

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
    return EXIT.OK;
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
  return EXIT.OK; // 도달하지 않음
}
