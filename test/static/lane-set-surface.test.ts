import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findSub, subFlagNames } from "../../src/cli/spec.js";
import { exposedEditFlags } from "../../src/core/lane-schema.js";

// 017-lane-set D3 (5a AUTHORING) — CLI 표면 정적 단정. findSub/subFlagNames 는 기존 export 라
// static import 가 안전(B1/B2 미착지여도 파일 자체는 로드되고, 개별 it 만 RED — PROC-R15).
// LANE_SET_IDENTITY_FLAGS 는 신규 export 라 named import 시 미착지 구간에서 SyntaxError 로 파일
// 전체가 붕괴할 수 있어 네임스페이스 동적 import 로 접근한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const EXPECTED_SET_EDIT_FLAGS = [
  "--perm-tier",
  "--allowlist",
  "--denylist",
  "--hard-deny",
  "--cwd",
  "--engine-args",
  "--lang",
  "--file-mode",
  "--chat-id",
  "--allow-from",
  "--root",
  "--inbox",
  "--approvals",
  "--outbox",
] as const;

const IDENTITY_EXCLUDED_FLAGS = [
  "--source",
  "--token-stdin",
  "--safe-defaults",
  "--force",
  "--interactive",
  "--no-interactive",
] as const;

// I5(v0.2.1/011): 목록 필드 증분 편집 플래그 — 스키마 필드 플래그가 아니라 기존 목록 필드
// (allowlist/denylist/hard_deny)의 add/rm 연산 변형이다. --unset 과 마찬가지로 스키마-파생 값 플래그
// 집합 대조에서 제외한다(스키마 필드 단일 SoT 불변식은 이 변형을 뺀 뒤 성립).
const LIST_INCREMENT_FLAGS = new Set([
  "--add-allow",
  "--rm-allow",
  "--add-deny",
  "--rm-deny",
  "--add-hard-deny",
  "--rm-hard-deny",
]);

/** 스키마-파생 대조 대상인 값 플래그만 남긴다(boolean --unset·증분 변형 제외). */
function schemaComparableSetFlags(): Set<string> {
  return new Set(
    subFlagNames("lane", "set").filter((f) => f !== "--unset" && !LIST_INCREMENT_FLAGS.has(f)),
  );
}

describe("CLI 표면 등록 (SC-016)", () => {
  it("findSub('lane','set') 이 정의되고 위치 인자가 [proj, lane] 이며 편집 플래그가 비어있지 않다", () => {
    const sub = findSub("lane", "set");
    expect(sub, "lane set 서브스펙이 spec.ts 에 등록되어야 한다").toBeDefined();
    expect(sub?.positional).toEqual(["proj", "lane"]);
    expect(sub?.flags.length ?? 0).toBeGreaterThan(0);
  });

  it("subFlagNames('lane','set') 에 14개 편집 플래그가 전부 포함된다", () => {
    const names = subFlagNames("lane", "set");
    for (const f of EXPECTED_SET_EDIT_FLAGS) {
      expect(names, `${f} 가 lane set 플래그에 없음`).toContain(f);
    }
  });

  it("lane set 편집 플래그 = lane-schema 파생(exposedEditFlags) 과 정확히 일치한다(단일 SoT 대조)", () => {
    // 003-lane-settings-commands: EXPECTED_SET_EDIT_FLAGS 를 스키마 파생과 대조해 드리프트를 잡는다.
    // 명명 플래그를 갖는 노출 편집 키의 플래그 집합이 spec.ts 의 set 값 플래그와 일치해야 한다
    // (--unset 은 boolean 모드 스위치라 값 플래그 목록에서 제외).
    const schemaFlags = new Set(exposedEditFlags());
    expect(schemaFlags).toEqual(new Set(EXPECTED_SET_EDIT_FLAGS));
    // 증분 변형·--unset 을 뺀 값 플래그 집합이 스키마 파생과 정확히 일치(단일 SoT).
    expect(schemaComparableSetFlags()).toEqual(schemaFlags);
  });

  it("목록 증분 편집 플래그 6종이 lane set 표면에 모두 등록돼 있다(I5)", () => {
    const setNames = new Set(subFlagNames("lane", "set"));
    for (const f of LIST_INCREMENT_FLAGS) {
      expect(setNames.has(f), `${f} 가 lane set 플래그에 없음`).toBe(true);
    }
  });
});

describe("편집 플래그 부분집합 (SC-019)", () => {
  it("set 값 플래그 집합 = add 플래그 − {정체성·token-stdin·safe-defaults·force·interactive·no-interactive} (+ boolean --unset)", () => {
    const addNames = new Set(subFlagNames("lane", "add"));
    // --unset(boolean 모드 스위치)·증분 변형(I5)은 add 표면에 없으므로 부분집합 비교에서 분리한다.
    const setNames = schemaComparableSetFlags();
    const expected = new Set(
      [...addNames].filter((n) => !(IDENTITY_EXCLUDED_FLAGS as readonly string[]).includes(n)),
    );
    expect(setNames).toEqual(expected);
    expect(subFlagNames("lane", "set")).toContain("--unset");
  });

  it("제외 대상 플래그는 set 에 존재하지 않는다", () => {
    const setNames = subFlagNames("lane", "set");
    for (const f of IDENTITY_EXCLUDED_FLAGS) {
      expect(setNames, `${f} 는 lane set 에 없어야 한다`).not.toContain(f);
    }
  });
});

describe("토큰 미노출 (SC-021)", () => {
  it("set 플래그에 --token·--token-stdin 이 없다", () => {
    const setNames = subFlagNames("lane", "set");
    expect(setNames).not.toContain("--token");
    expect(setNames).not.toContain("--token-stdin");
  });

  it("LANE_SET_IDENTITY_FLAGS 는 정확히 4개 정체성 플래그이며 LANE_SET_FLAGS 와 disjoint 하다", async () => {
    const spec = (await import("../../src/cli/spec.js")) as unknown as {
      LANE_SET_IDENTITY_FLAGS?: readonly string[];
    };
    const identityFlags = spec.LANE_SET_IDENTITY_FLAGS;
    expect(identityFlags, "LANE_SET_IDENTITY_FLAGS 가 spec.ts 에 export 되어야 한다").toBeDefined();
    expect([...(identityFlags ?? [])].sort()).toEqual(
      ["--acp-version", "--backend", "--engine", "--source"].sort(),
    );
    const setNames = new Set(subFlagNames("lane", "set"));
    for (const f of identityFlags ?? []) {
      expect(setNames.has(f), `${f} 는 LANE_SET_FLAGS 에 없어야 한다(자동완성 미노출)`).toBe(false);
    }
  });
});

describe("안전 경계 — set 코드가 gate 미의존 (SC-018 보조)", () => {
  it("lane.ts·lane-config.ts 가 src/gate 를 import 하지 않는다", () => {
    const laneTs = fs.readFileSync(path.join(repoRoot, "src/cli/lane.ts"), "utf8");
    const laneConfigTs = fs.readFileSync(path.join(repoRoot, "src/core/lane-config.ts"), "utf8");
    expect(laneTs).not.toMatch(/from\s+["']\.\.\/gate/);
    expect(laneConfigTs).not.toMatch(/from\s+["']\.\.\/gate/);
  });
});
