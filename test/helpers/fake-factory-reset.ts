/**
 * 006(D017) — `FactoryResetDeps`(design.md §11) 더블. 실 launchd 데몬 정지·실제 설치 파괴 없이
 * "데몬 정지 요청됨"·"정지 후 잔존 확인" 두 비자명 동작을 재현한다(quirk 재현 의무 — infra.md §4
 * [MUST]): (a) `stopDaemon` 은 실제로 프로세스를 내리지 않고 "정지 요청됨" 상태만 기록하므로
 * 테스트가 `residueAfterStop` 을 통해 "정지했는데도 잔존"(SC-078 Error) 을 임의로 재현할 수 있다.
 * (b) 정지 요청 없이 잔존을 물으면(정지 누락 버그) 즉시 true 를 반환해 순서 위반을 드러낸다.
 */
export interface FakeFactoryResetControl {
  /** 정지 후에도 잔존한 것처럼 만든다(SC-078 Error — 삭제 0건 중단 경로 재현). */
  forceResidueAfterStop(proj: string): void;
  stopCallCount(): number;
  stoppedProjects(): readonly string[];
}

export function makeFakeFactoryResetDeps(base: string): {
  deps: {
    base: string;
    stopDaemon: (proj: string) => Promise<void>;
    daemonResidue: (proj: string) => Promise<boolean>;
  };
  control: FakeFactoryResetControl;
} {
  const stoppedAt = new Map<string, boolean>();
  const forcedResidue = new Set<string>();
  const stopped: string[] = [];

  return {
    deps: {
      base,
      async stopDaemon(proj: string) {
        stoppedAt.set(proj, true);
        stopped.push(proj);
      },
      async daemonResidue(proj: string) {
        // 정지 호출 없이 잔존을 묻는 것은 순서 위반(설계 §11 3단계 — 정지 먼저)이므로 방어적으로
        // "잔존"으로 답한다(누락을 조용히 통과시키지 않는다).
        if (!stoppedAt.get(proj)) return true;
        return forcedResidue.has(proj);
      },
    },
    control: {
      forceResidueAfterStop(proj: string) {
        forcedResidue.add(proj);
      },
      stopCallCount() {
        return stopped.length;
      },
      stoppedProjects() {
        return stopped;
      },
    },
  };
}
