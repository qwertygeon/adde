import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 측정 대상은 소스만 — 진입점(엔트리)은 제외. 임계 미설정(측정만, CI 비게이트).
      include: ["src/**/*.ts"],
      exclude: ["src/cli/adde.ts", "src/cli/add.ts"],
    },
  },
});
