import { errMsg } from "../shared/errors.js";
import { EXIT } from "./messages.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { installCrashGuard } from "./crash-guard.js";
import type { ShutdownState } from "./crash-guard.js";
import { createCrashLoopGuard } from "./crash-loop.js";
import { defaultBase, projectPaths } from "../shared/paths.js";
import { writeBootReport } from "./boot-report.js";
import { startLiveness, removeLivenessRecord } from "./liveness.js";
import type { LivenessHandle } from "./liveness.js";

/**
 * 포그라운드 데몬 워커 로직(v2) — `adde __daemon <proj>` 가 호출한다.
 * supervisorUp(세션 축 조립) 후 SIGTERM/SIGINT graceful shutdown 까지 포그라운드 상주.
 */
export async function runDaemonForeground(proj: string): Promise<number> {
  const shutdownState: ShutdownState = { active: false };
  // holder 객체 — 각 필드는 이 함수 안에서 1회만 채워지지만, 아래에서 정의되는 shutdown 클로저가
  // 나중에 채워질 값을 참조해야 하므로 forward-reference 가 가능한 가변 컨테이너로 둔다.
  const state: {
    crashLoop?: ReturnType<typeof createCrashLoopGuard>;
    liveness?: LivenessHandle;
  } = {};

  // `supervisor.js` 동적 import 는 최초 로드 시 전이 의존(엔진·surface 등)까지 평가하는 비용이
  // 있다 — 이 함수의 **첫 await 이전**(=아래 두 등록 호출까지)은 동기 실행이 보장되므로, 신호
  // 핸들러·크래시 가드를 이보다 먼저(=import 도 하기 전에) 설치해야 기동 직후 종료 요청이
  // import 대기 창에서 유실되지 않는다(FR-013·ADR-013 — 시그널 핸들러 선설치).
  installCrashGuard({
    onCleanup: async () => {
      const { supervisorDown } = await import("./supervisor.js");
      await supervisorDown(proj);
    },
    exit: (code) => process.exit(code),
    log: (line) => process.stderr.write(`${line}\n`),
    state: shutdownState,
  });

  const shutdown = (sig: NodeJS.Signals): void => {
    if (shutdownState.active) return;
    shutdownState.active = true;
    state.crashLoop?.disarm();
    process.stderr.write(`\n${t("run.signalShutdown", { sig })}\n`);
    void (async () => {
      try {
        const { supervisorDown } = await import("./supervisor.js");
        await supervisorDown(proj);
        if (state.liveness) {
          await state.liveness.stop();
        } else {
          await removeLivenessRecord(projectPaths(defaultBase(), proj), (line) =>
            process.stderr.write(`${line}\n`),
          );
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          formatException({
            situation: t("run.shutdownError.situation", { error: errMsg(err) }),
            action: t("run.shutdownError.action"),
          }) + "\n",
        );
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const { supervisorUp } = await import("./supervisor.js");

  state.crashLoop = createCrashLoopGuard({ base: defaultBase(), proj });
  const { halt } = await state.crashLoop.checkOnBoot();
  if (halt) return EXIT.OK;

  const result = await supervisorUp(proj);

  // 기동 창 경합 가드 — 조립 resolve 직후 종료 진행 중이면 기록·리포트·타이머·안내를 생략한다.
  // 종료 소유는 `shutdown()`(위)로 이전한다 — 여기서 EXIT.OK 를 반환하면 최상단 `process.exit`
  // 가 `shutdown()` 의 정리(동적 import + supervisorDown + 기록 제거) 완료 전에 선점해 전역 규칙
  // (비동기 작업 완료 전 process.exit 금지)을 위반한다. `shutdown()` 자신이 정리를 마친 뒤
  // `process.exit` 를 호출하므로, 여기서는 resolve 하지 않고 그 종료를 기다린다.
  if (shutdownState.active) {
    await new Promise<never>(() => {});
  }

  // 권한 재적용(supervisorUp 의 applyProjectFileMode) 이후에 기록을 쓴다(ADR-016 — 0755 창 회피).
  state.liveness = await startLiveness({
    proj,
    paths: projectPaths(defaultBase(), proj),
    warn: (line) => process.stderr.write(`${line}\n`),
  });

  // 기록 생성 직후 재확인 — 원자적 쓰기(임시파일→이름변경) 도중에 `shutdown()` 의 제거가 끼어들면
  // "제거 후 기록이 되살아나는" 역전 창이 생긴다(정상 종료인데 잔존 기록으로 비정상 종료 오보고).
  // `state.liveness.stop()` 은 멱등이므로 `shutdown()` 쪽과 중복 호출돼도 안전하다.
  if (shutdownState.active) {
    await state.liveness.stop();
    await new Promise<never>(() => {});
  }

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
          sid: s.sid,
          error: t("run.unknownCause"),
        }),
        action: t("run.laneStartFailed.action", { proj, sid: s.sid }),
      }) + "\n",
    );
  }

  // 안정 판정 arm — minLifetimeMs(기본 60초) 생존 시 크래시루프 카운터 리셋.
  state.crashLoop.armStable();

  // 데몬은 세션 활성 여부와 무관하게 상주한다(v2 — 세션이 0개여도 새 세션 생성을 받아야 하므로
  // v1 의 "레인 0개면 즉시 종료" 정책은 폐기한다). 종료(SIGTERM/SIGINT) 까지 resolve 하지 않는다.
  await new Promise<never>(() => {});
  return EXIT.OK; // 도달하지 않음
}
