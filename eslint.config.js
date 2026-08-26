import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // poc/·poc-results/ 는 gitignore 된 스크래치(실측 PoC 스크립트) — 게이트 대상이 아니다.
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "poc/**", "poc-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
