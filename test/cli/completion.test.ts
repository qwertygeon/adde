import { describe, expect, it } from "vitest";
import { completionScript, SUPPORTED_SHELLS } from "../../src/cli/completion.js";
import { LANE_ADD_FLAGS, visibleCommands } from "../../src/cli/spec.js";

// 셸 자동완성 스크립트 — 스펙(SSOT)에서 명령·플래그 파생.

describe("completionScript", () => {
  it("미지원 셸은 null", () => {
    expect(completionScript("fish")).toBeNull();
    expect(completionScript("")).toBeNull();
  });

  it("bash 스크립트에 모든 노출 명령과 complete 등록이 포함된다", () => {
    const script = completionScript("bash");
    expect(script).not.toBeNull();
    const s = script as string;
    for (const c of visibleCommands()) expect(s).toContain(c.name);
    expect(s).toContain("complete -F _adde adde add"); // 두 진입점 등록
    // lane add 플래그가 완성 후보에 포함
    expect(s).toContain("--allow-from");
    expect(s).toContain("--file-mode");
  });

  it("zsh 스크립트는 compdef 헤더와 등록을 포함한다", () => {
    const s = completionScript("zsh") as string;
    expect(s.startsWith("#compdef adde add")).toBe(true);
    expect(s).toContain("compdef _adde adde add");
    for (const f of LANE_ADD_FLAGS) expect(s).toContain(f);
  });

  it("두 지원 셸 모두 스크립트를 생성한다", () => {
    for (const shell of SUPPORTED_SHELLS) {
      expect(completionScript(shell)).toBeTruthy();
    }
  });
});
