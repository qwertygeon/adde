import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-053 (정적) — `session rm` 에서 `--force` 가 완전히 제거된다: 플래그 선언·usage 문구(en·ko)
// 어디에도 남아있지 않다(project rm 의 --force 는 범위 외 유지 — GAP-005, project 쪽은 대상 아님).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("SC-053: session rm --force 잔존 0건", () => {
  it("Happy: src/cli/spec.ts 의 session rm SubSpec 에 --force 플래그가 없다", async () => {
    const specSrc = fs.readFileSync(path.join(repoRoot, "src/cli/spec.ts"), "utf8");
    const sessionSubsMatch = /const SESSION_SUBS[\s\S]*?\];/.exec(specSrc);
    expect(sessionSubsMatch).not.toBeNull();
    const sessionSubsBlock = sessionSubsMatch![0];
    const rmLine = sessionSubsBlock.split("\n").find((l) => /name:\s*"rm"/.test(l));
    expect(rmLine).toBeDefined();
    expect(rmLine).not.toContain("--force");
  });

  it("Edge: session rm --purge --force 조합도 미인식 플래그로 거부된다(파서 계약)", async () => {
    const mod = await import("../../src/cli/session.js");
    const { captureSink } = await import("../helpers/prompt-fixtures.js");
    const runSession = (
      mod as unknown as {
        runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
      }
    ).runSession;
    const { output } = captureSink();
    const origWrite = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    process.stderr.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as never;
    // 미인식 플래그는 base 해석 전(parseCommand 단계)에 거부되므로 실 ADDE_HOME 접촉이 없어야
    // 정상이나, 방어적으로 격리 경로를 강제해 어떤 경우에도 실 설정 루트를 건드리지 않게 한다.
    const origHome = process.env["ADDE_HOME"];
    process.env["ADDE_HOME"] = "/nonexistent-adde-home-guard";
    try {
      const code = await runSession(["rm", "any-proj", "any-sid", "--purge", "--force"], {
        interactive: false,
      });
      expect(code).not.toBe(0);
    } finally {
      process.stderr.write = origWrite;
      if (origHome === undefined) delete process.env["ADDE_HOME"];
      else process.env["ADDE_HOME"] = origHome;
    }
    void output;
  });

  it("Error: usage.session 본문(en·ko)에 --force 문자열이 등장하지 않는다", async () => {
    const en = fs.readFileSync(path.join(repoRoot, "src/shared/locales/en.ts"), "utf8");
    const ko = fs.readFileSync(path.join(repoRoot, "src/shared/locales/ko.ts"), "utf8");
    for (const [label, src] of [
      ["en", en],
      ["ko", ko],
    ] as const) {
      // 실측 구조(src/shared/locales/en.ts): `usage: { session: \`...\` }` 중첩 객체 — 리터럴
      // "usage.session" 문자열이 아니라 `session:` 키의 템플릿 리터럴 본문을 찾는다.
      const usageBlockMatch = /session:\s*`([\s\S]*?)`/.exec(src);
      expect(
        usageBlockMatch,
        `${label} usage.session(session: 키) 블록을 찾지 못함`,
      ).not.toBeNull();
      expect(usageBlockMatch![1]).not.toContain("--force");
    }
  });
});
