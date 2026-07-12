import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("정적 분석 — acp_version 단일 소스 (SC-007)", () => {
  it("ACP_VERSION 은 acp.PROTOCOL_VERSION 에서 파생된 라벨과 일치한다(drift 안전망)", async () => {
    // ACP_VERSION 은 PPG-1 병렬 중 4단계가 아직 착지하지 않았을 수 있는 신규 심볼 — 동적 import 로
    // 개별 격리한다(미착지 시 이 테스트만 RED, 파일 전체 붕괴 방지).
    const { ACP_VERSION } = await import("../../src/shared/conf.js");
    expect(ACP_VERSION).toBe(`v${acp.PROTOCOL_VERSION}`);
  });

  it("acp_version 리터럴 \"v1\" 은 conf.ts 의 상수 정의 1곳에만 존재한다(다른 소비처는 상수 참조)", () => {
    const targets = [
      "src/shared/conf.ts",
      "src/backend/acp/client.ts",
      "src/core/lane-config.ts",
    ];
    const literalPattern = /"v1"/g;
    let totalMatches = 0;
    const perFile: Record<string, number> = {};
    for (const rel of targets) {
      const file = path.join(repoRoot, rel);
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      const count = (content.match(literalPattern) ?? []).length;
      perFile[rel] = count;
      totalMatches += count;
    }
    // conf.ts 의 `export const ACP_VERSION = "v1";` 정의 1곳만 허용 — 나머지 소비처는 ACP_VERSION 참조.
    expect(totalMatches, JSON.stringify(perFile)).toBe(1);
    expect(perFile["src/shared/conf.ts"]).toBe(1);
  });
});

describe("정적 분석 — 코어 엔진/백엔드 식별 분기 부재 (SC-014)", () => {
  it("src/core/ 하위 소스에 엔진·백엔드 식별 분기(if engine==/if backend==)가 없다", () => {
    const coreDir = path.join(repoRoot, "src/core");
    const pattern = /\b(?:engine|backend)\s*===?\s*["'`]/;
    const violations: string[] = [];
    for (const entry of fs.readdirSync(coreDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const full = path.join(coreDir, entry.name);
      const content = fs.readFileSync(full, "utf8");
      if (pattern.test(content)) violations.push(entry.name);
    }
    expect(violations).toEqual([]);
  });
});

// SC-016 최종 문구·위치는 6단계 Docs Agent 확정 대상(설계 HOW 위임) — 본 테스트는 "표기 존재"만
// 요구한다. Docs 착지 전까지 RED 가 예상 상태이며(순서 유예), Docs 착지 후 재실행으로 GREEN 확정한다.
describe("정적 분석 — engine_args 시크릿 경계 표기 존재 (SC-016, 순서 유예)", () => {
  const candidateFiles = [
    path.join(repoRoot, "CHANGELOG.md"),
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, "src/shared/locales/en.ts"),
    path.join(repoRoot, "src/shared/locales/ko.ts"),
  ];

  /** engine_args 언급과 시크릿-경계 언급이 같은 줄에 함께 있는지(우연한 동시등장 오탐 축소). */
  function hasCoOccurrence(content: string): boolean {
    const mentionsEngineArgs = /engine[_-]args/i;
    const mentionsBoundary = /(시크릿|비밀|토큰|secret|token)/i;
    return content
      .split(/\r?\n/)
      .some((line) => mentionsEngineArgs.test(line) && mentionsBoundary.test(line));
  }

  it("engine_args 가 ADDE 시크릿 전달 수단이 아니라는 경계 표기가 문서/도움말 중 한 곳에 존재한다", () => {
    const found = candidateFiles.some((file) => {
      if (!fs.existsSync(file)) return false;
      return hasCoOccurrence(fs.readFileSync(file, "utf8"));
    });
    expect(found).toBe(true);
  });
});
