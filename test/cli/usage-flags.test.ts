import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsage, USAGE } from "../../src/core/messages.js";
import { setLocale, getLocale, resolveLocale, t } from "../../src/shared/i18n.js";

// L-1 회귀 방지 — 008 이 추가한 관찰성 플래그(logs -f/--follow, doctor/sessions --json)가
// 메인 usage 및 명령별 usage 텍스트에 en·ko 양쪽 반영됐는지 검증 (SC-108·SC-108b).
// SC-116: C-1·H-1·N-3 방어 실 프로세스 spawn 회귀 테스트 파일의 존재를 정적으로 확인한다.

afterAll(() => setLocale(resolveLocale()));

function lineContaining(text: string, marker: string): string | undefined {
  return text.split("\n").find((l) => l.includes(marker));
}

describe("logs usage — --follow/-f 표기 (SC-108 Happy)", () => {
  it("메인 usage(logs 행)와 usage.logs 에 en·ko 양쪽 --follow/-f 가 표기된다", () => {
    for (const locale of ["en", "ko"] as const) {
      setLocale(locale);
      expect(getLocale()).toBe(locale);
      const main = buildUsage();
      const logsLine = lineContaining(main, "logs <proj> <lane>");
      expect(logsLine, `${locale} main usage 에 logs 행이 없음`).toBeDefined();
      expect(logsLine).toMatch(/-f|--follow/);
      expect(USAGE.logs).toMatch(/-f|--follow/);
    }
  });
});

describe("doctor·sessions usage — --json 표기 (SC-108b Happy)", () => {
  it("메인 usage(doctor·sessions 행)와 명령별 usage 에 en·ko 양쪽 --json 이 표기된다", () => {
    for (const locale of ["en", "ko"] as const) {
      setLocale(locale);
      const main = buildUsage();
      const doctorLine = lineContaining(main, "doctor [<proj>]");
      const sessionsLine = lineContaining(main, "sessions <proj> <lane>");
      expect(doctorLine, `${locale} main usage 에 doctor 행이 없음`).toBeDefined();
      expect(doctorLine).toContain("--json");
      expect(sessionsLine, `${locale} main usage 에 sessions 행이 없음`).toBeDefined();
      expect(sessionsLine).toContain("--json");
      expect(t("usage.doctor")).toContain("--json");
      expect(USAGE.sessions).toContain("--json");
    }
  });
});

describe("SC-116: 실 프로세스 spawn 회귀 테스트 존재", () => {
  it("C-1·H-1·N-3 방어 spawn 기반 회귀 테스트 파일이 존재하고 SIGINT·child_process 를 다룬다", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const specPath = path.join(repoRoot, "test", "integration", "logs-follow-spawn.test.ts");
    expect(fs.existsSync(specPath)).toBe(true);
    const content = fs.readFileSync(specPath, "utf8");
    expect(content).toMatch(/child_process/);
    expect(content).toMatch(/SIGINT/);
  });
});
