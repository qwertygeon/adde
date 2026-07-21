import { describe, expect, it } from "vitest";
import { completionScript, SUPPORTED_SHELLS } from "../../src/cli/completion.js";
import { visibleCommands, subFlagNames } from "../../src/cli/spec.js";
import { exposedEditableKeys } from "../../src/core/lane-schema.js";

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
    // proj 서브커맨드 배선(ls/rm) — rm 뒤 프로젝트 이름 완성.
    expect(bash).toContain("proj)");
    expect(bash).toContain("ls rm help");
    expect(zsh).toContain("'proj subcommand'");
  });

  it("zsh 스크립트는 compdef 헤더와 등록(ad·add)·명령 설명을 포함한다", () => {
    const s = completionScript("zsh") as string;
    expect(s.startsWith("#compdef adde ad add")).toBe(true);
    expect(s).toContain("compdef _adde adde ad add");
    // _describe 명령 설명(desc)
    expect(s).toContain("'init:guided setup'");
    for (const f of subFlagNames("lane", "add")) expect(s).toContain(f);
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

// drift 교정(SC-003 Happy) — doctor·sessions 의 --json, logs 의 --follow/-f 가 자동완성에 노출된다.
// 해당 명령의 case 블록만 좁혀 확인해 status 등 무관 명령의 --json 잔존과 오탐되지 않게 한다.
function commandBlock(script: string, name: string): string {
  const lines = script.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === `${name})`);
  expect(startIdx, `${name}) 블록을 찾을 수 없음`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^ {4}\S.*\)/.test(l) || l.trim() === "esac");
  return lines.slice(startIdx, startIdx + 1 + (endOffset === -1 ? rest.length : endOffset)).join("\n");
}

describe("drift 교정 — doctor·sessions --json, logs --follow/-f 완성 노출 (SC-003 Happy)", () => {
  it("bash: doctor·sessions case 블록에 --json 이 포함된다", () => {
    const bash = completionScript("bash") as string;
    expect(commandBlock(bash, "doctor")).toContain("--json");
    expect(commandBlock(bash, "sessions")).toContain("--json");
  });

  it("bash: logs case 블록에 --follow 와 -f 가 포함된다", () => {
    const bash = completionScript("bash") as string;
    const block = commandBlock(bash, "logs");
    expect(block).toContain("--follow");
    expect(block).toContain("-f");
  });

  it("zsh: doctor·sessions case 블록에 --json 이 포함된다", () => {
    const zsh = completionScript("zsh") as string;
    expect(commandBlock(zsh, "doctor")).toContain("--json");
    expect(commandBlock(zsh, "sessions")).toContain("--json");
  });

  it("zsh: logs case 블록에 --follow 와 -f 가 포함된다", () => {
    const zsh = completionScript("zsh") as string;
    const block = commandBlock(zsh, "logs");
    expect(block).toContain("--follow");
    expect(block).toContain("-f");
  });
});

describe("lane set/show 점표기 키 완성 (스키마 파생)", () => {
  it("bash: lane set 에 노출 편집 키 전체와 set 플래그가 완성 후보로 포함된다", () => {
    const bash = completionScript("bash") as string;
    // 스키마(SoT) 파생 — 키 추가 시 자동 반영되는지 전수 대조.
    for (const key of exposedEditableKeys()) expect(bash).toContain(key);
    expect(bash).toContain("--unset");
    // 명명플래그 없는 점표기 전용 키(markdown 그룹) 대표 확인.
    expect(bash).toContain("markdown.retention_days");
  });

  it("bash: lane show 5번째 슬롯([key])에 키 완성이 배선된다", () => {
    const bash = completionScript("bash") as string;
    const showIdx = bash.indexOf("show)");
    expect(showIdx).toBeGreaterThanOrEqual(0);
    const showBlock = bash.slice(showIdx, bash.indexOf(";;", showIdx));
    expect(showBlock).toContain('"$cword" -eq 5');
    expect(showBlock).toContain("markdown.retention_days");
  });

  it("zsh: lane set/show 에 점표기 키 완성이 배선된다", () => {
    const zsh = completionScript("zsh") as string;
    for (const key of exposedEditableKeys()) expect(zsh).toContain(key);
    const setIdx = zsh.indexOf("set)");
    expect(setIdx).toBeGreaterThanOrEqual(0);
    const setBlock = zsh.slice(setIdx, zsh.indexOf(";;", setIdx));
    expect(setBlock).toContain("compadd");
    expect(setBlock).toContain("--unset");
  });
});
