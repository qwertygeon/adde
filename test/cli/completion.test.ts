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
    expect(s).toContain("complete -F _adde adde ad add"); // adde + 짧은 별칭(ad·add) 등록
    // lane add 플래그가 완성 후보에 포함
    expect(s).toContain("--allow-from");
    expect(s).toContain("--file-mode");
  });

  it("동적 proj/lane·enum·디렉터리 완성 배선이 포함된다 (A1-A3)", () => {
    const bash = completionScript("bash") as string;
    // 동적 이름: base 스캔 헬퍼
    expect(bash).toContain("_adde_projects");
    expect(bash).toContain("_adde_lanes");
    // enum 값: --source markdown|telegram, --perm-tier acp|autopass
    expect(bash).toContain("markdown telegram");
    expect(bash).toContain("acp autopass");
    // 디렉터리 플래그
    expect(bash).toContain("--cwd|--root");
    expect(bash).toContain("compgen -d");
    const zsh = completionScript("zsh") as string;
    expect(zsh).toContain("_adde_projects");
    expect(zsh).toContain("_files -/");
  });

  it("zsh 스크립트는 compdef 헤더와 등록(ad·add)·명령 설명을 포함한다", () => {
    const s = completionScript("zsh") as string;
    expect(s.startsWith("#compdef adde ad add")).toBe(true);
    expect(s).toContain("compdef _adde adde ad add");
    // _describe 명령 설명(desc)
    expect(s).toContain("'init:guided setup'");
    for (const f of LANE_ADD_FLAGS) expect(s).toContain(f);
  });

  it("lane add 레인이름 슬롯에서 옵션 플래그를 제안하지 않는다 (bash·zsh 정합)", () => {
    // bash: cword 4(레인이름) 는 -로 시작할 때만 플래그, 그 전엔 자유 입력.
    const bash = completionScript("bash") as string;
    expect(bash).toContain('[ "$cword" -ge 5 ] || [ "${cur:0:1}" = "-" ]');
    // zsh: CURRENT 5(레인이름)에서 -로 시작하지 않으면 제안 억제(bash 와 동일 동작).
    const zsh = completionScript("zsh") as string;
    expect(zsh).toContain('if (( CURRENT == 5 )) && [[ "${words[5]}" != -* ]]; then return; fi');
  });

  it("두 지원 셸 모두 스크립트를 생성한다", () => {
    for (const shell of SUPPORTED_SHELLS) {
      expect(completionScript(shell)).toBeTruthy();
    }
  });
});
