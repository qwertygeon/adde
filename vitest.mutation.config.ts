import { defineConfig } from "vitest/config";

// mutation 전용 — 워크플로 도메인 테스트만. 소스 글자를 검사하는 test/static 은 계측 코드 때문에 실패하므로 제외.
export default defineConfig({
  test: {
    include: ["test/workflow/domain/**/*.test.ts"],
    environment: "node",
  },
});
