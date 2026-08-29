/**
 * markdown Surface(L4) 노트 훅 3종 배선 — `supervisor.ts`(데몬 조립)·`cli/session-manager-helper.ts`
 * (CLI 단독/데몬 미기동 조립)가 공유한다(rework3 — 같은 배선을 두 조립 지점에 각각 복제했다가
 * CLI 쪽이 누락된 채 방치돼 데몬 미기동 시 `session stop/resume`이 노트를 갱신하지 못하는 실제
 * 결함으로 이어졌다). 이 모듈 자체는 두 조립 지점 전용 "assembly 헬퍼" 다 — L3 코어(`session-manager.ts`)
 * 는 여전히 L4 를 import 하지 않는다(계층 규약 불변, `session-manager.ts` 는 이 모듈을 참조하지 않는다).
 */
import {
  hasUnconsumedSend,
  restoreActiveNote,
  writeStoppedNote,
} from "../surfaces/markdown/index.js";
import type { SessionManagerDeps, SessionManagerWithLoad } from "./session-manager.js";
import type { EngineCaps } from "../engines/types.js";

/** `capsOf` 미조회(방어) 시 폴백(A-P007 — 코어가 엔진을 모르므로 "모른다" 를 표현하는 안전한 기본값). */
const DEFAULT_ENGINE_CAPS: EngineCaps = {
  resume: "none",
  permission: "none",
  streaming: false,
  usage: false,
  compact: "none",
  attachments: [],
};

/**
 * 노트 훅 3종(`onStopApplied`·`onResumeApplied`·`pendingSurfaceWork`) 생성.
 * `sm` 은 `SessionManagerDeps` 조립 리터럴 **안에서** 자기 자신(완성된 `SessionManager`)을
 * 참조해야 하는 순환 때문에 즉시값이 아니라 getter 로 받는다 — 호출 시점(훅이 실제 실행되는
 * 시점)에는 `createSessionManager(...)` 가 이미 반환을 마쳤으므로 안전하다(호출자 쪽의
 * `const sm = createSessionManager({ ...markdownSessionHooks({ sm: () => sm }) })` self-reference
 * 패턴, `supervisor.ts`/`session-manager-helper.ts` 양쪽에서 동일하게 성립).
 */
export function markdownSessionHooks(a: {
  vaultRoot: string;
  proj: string;
  sm: () => Pick<SessionManagerWithLoad, "capsOf" | "get" | "takeNotices">;
}): Pick<SessionManagerDeps, "onStopApplied" | "onResumeApplied" | "pendingSurfaceWork"> {
  const { vaultRoot, proj } = a;
  return {
    onStopApplied: async (sid, info) => {
      await writeStoppedNote({ vaultRoot, proj, sid }, info);
    },
    onResumeApplied: async (sid) => {
      const sm = a.sm();
      await restoreActiveNote(
        { vaultRoot, proj, sid },
        {
          caps: sm.capsOf(sid) ?? DEFAULT_ENGINE_CAPS,
          warnings: sm.get(sid)?.warnings ?? [],
          notices: sm.takeNotices(sid),
        },
      );
    },
    pendingSurfaceWork: (sid) => hasUnconsumedSend({ vaultRoot, proj, sid }),
  };
}
