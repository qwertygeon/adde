import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // 테스트 파일 병렬 실행 상한 — 기본값(논리 코어−1)은 데몬·엔진 자식을 띄우는 통합 테스트와 겹쳐 머신을 과부하시킨다.
    maxWorkers: 4,
    // 기본 5초 — git 을 여러 번 부르는 정적 기준선 검사가 전체 스위트 부하 중 넘긴 실측(2026-10-10)이 있다.
    // 자체 제한시간을 둔 테스트는 영향 없음.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 측정 대상은 소스만 — 진입점(엔트리)은 제외. 임계 미설정(측정만, CI 비게이트).
      include: ["src/**/*.ts"],
      exclude: ["src/cli/adde.ts", "src/cli/add.ts"],
    },
  },
});
