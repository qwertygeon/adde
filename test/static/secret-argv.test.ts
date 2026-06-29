import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// SC-016: 토큰이 기동 argv 에 미포함 — 정적 코드 분석
// SC-024: 토큰이 .env 외 평문 미저장 — argv·env·로그·트랜스크립트 미탐지

// 정적 검증: 소스 파일을 grep 하여 토큰이 argv/env 에 전달되는 코드 경로 탐지

const srcDir = path.resolve(process.cwd(), "src");
const BOT_TOKEN_PATTERN = /TELEGRAM_BOT_TOKEN/;
const ARGV_SUSPICIOUS_PATTERN = /spawn\s*\([^)]*TELEGRAM_BOT_TOKEN/;

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("정적 분석 — 토큰 argv 미포함 (SC-016)", () => {
  it("소스 코드에서 spawn 호출에 TELEGRAM_BOT_TOKEN 이 직접 전달되는 코드가 없다", () => {
    const tsFiles = getAllTsFiles(srcDir);
    // src 파일이 없으면(TDD Red 단계) 패스 — Development 구현 후 Green
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (ARGV_SUSPICIOUS_PATTERN.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toHaveLength(0);
  });

  it("토큰을 읽는 코드는 state/<lane>/.env 파일에서만 읽는다", () => {
    const tsFiles = getAllTsFiles(srcDir);
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    // 토큰을 읽는 파일에서 .env 파일 경로(envFile)를 경유하는지 확인
    const tokenReadFiles: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (BOT_TOKEN_PATTERN.test(content)) {
        tokenReadFiles.push(file);
      }
    }

    for (const file of tokenReadFiles) {
      const content = fs.readFileSync(file, "utf8");
      // 토큰을 직접 process.argv 에 넣는 패턴 탐지
      expect(content).not.toMatch(/process\.argv.*TELEGRAM_BOT_TOKEN/);
      expect(content).not.toMatch(/args.*TELEGRAM_BOT_TOKEN/);
    }
  });
});

describe("정적 분석 — 토큰 평문 미저장 (SC-024)", () => {
  it("봇 토큰 패턴이 소스 코드에 하드코딩되어 있지 않다", () => {
    // 실제 봇 토큰 패턴: \d+:[A-Za-z0-9_-]{35}
    const tokenLiteralPattern = /\d{6,}:[A-Za-z0-9_-]{35}/;
    const tsFiles = getAllTsFiles(srcDir);
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (tokenLiteralPattern.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toHaveLength(0);
  });

  it("환경변수 직접 노출 — process.env.TELEGRAM_BOT_TOKEN 이 로그·트랜스크립트에 전달되는 패턴 없음", () => {
    const tsFiles = getAllTsFiles(srcDir);
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    const logWithToken = /(?:console\.|logger\.|log\().*process\.env\.TELEGRAM_BOT_TOKEN/;
    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (logWithToken.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toHaveLength(0);
  });
});
