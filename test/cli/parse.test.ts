import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/cli/parse.js";

// 통합 파서 parseCommand — SC-002(파싱 결과가 기존 명령 동작과 일치)·SC-007(값 플래그 양형 수용).
// spec 인자는 tasks.md 확정 시그니처 {flags: readonly FlagSpec[]; positional?} 를 만족하는
// 리터럴 fixture 로 구성한다(A-01 착지 전이라도 D 레이어가 독립적으로 착수 가능 — TDD Red).

const statusSpec = { flags: [{ name: "--all" }, { name: "--json" }] };
const logsSpec = {
  flags: [{ name: "--engine" }, { name: "--daemon" }, { name: "--follow", short: "-f" }],
};
const laneAddSpec = {
  flags: [
    { name: "--source", takesValue: true },
    { name: "--engine", takesValue: true },
    { name: "--force" },
  ],
};

describe("parseCommand — status --json myproj 분리 (SC-002 Happy)", () => {
  it("positional=['myproj'], flags.json===true", () => {
    const res = parseCommand(statusSpec, ["--json", "myproj"]);
    expect(res.positional).toEqual(["myproj"]);
    expect(res.flags["json"]).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe("parseCommand — logs -f 가 N 으로 오인 안 됨 (SC-002 Edge)", () => {
  it("positional=['myproj','mylane'], flags.follow===true", () => {
    const res = parseCommand(logsSpec, ["myproj", "mylane", "-f"]);
    expect(res.positional).toEqual(["myproj", "mylane"]);
    expect(res.flags["follow"]).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("--follow(장형)도 동일하게 인식된다", () => {
    const res = parseCommand(logsSpec, ["myproj", "mylane", "--follow"]);
    expect(res.positional).toEqual(["myproj", "mylane"]);
    expect(res.flags["follow"]).toBe(true);
  });
});

describe("parseCommand — 값 플래그 양형 수용 (SC-007 Happy)", () => {
  it("`--source value` 와 `--source=value` 가 동일하게 flags.source 를 채운다", () => {
    const spaced = parseCommand(laneAddSpec, ["p", "l", "--source", "telegram"]);
    const eq = parseCommand(laneAddSpec, ["p", "l", "--source=telegram"]);
    expect(spaced.flags["source"]).toBe("telegram");
    expect(eq.flags["source"]).toBe("telegram");
    expect(spaced.positional).toEqual(["p", "l"]);
    expect(eq.positional).toEqual(["p", "l"]);
  });
});

describe("parseCommand — 값 누락 거부 (SC-007 Error)", () => {
  it("값 플래그 뒤 값이 없으면 error.kind==='value-required'", () => {
    const res = parseCommand(laneAddSpec, ["p", "l", "--source"]);
    expect(res.error?.kind).toBe("value-required");
    expect(res.error?.token).toContain("source");
  });

  it("값 플래그 뒤 다음 토큰이 다른 플래그(`-`로 시작)여도 값 누락으로 거부한다", () => {
    const res = parseCommand(laneAddSpec, ["p", "l", "--source", "--force"]);
    expect(res.error?.kind).toBe("value-required");
  });
});

// research.md §G 결정 3(quirk 보존): `-<digit...>`·bare `-` 는 단축 플래그가 아니라 위치인자로
// 취급한다 — logs [N] 위치의 `-5`(줄수 오입력) 를 미지원 플래그로 오판해 거부하지 않기 위함.
describe("parseCommand — 숫자 단축 토큰은 위치인자로 유지된다 (quirk 보존, 회귀 방지)", () => {
  it("`-5` 는 미지원 플래그 오류가 아니라 positional 에 남는다", () => {
    const res = parseCommand(logsSpec, ["p", "l", "-5"]);
    expect(res.error).toBeUndefined();
    expect(res.positional).toEqual(["p", "l", "-5"]);
  });

  it("bare `-` 도 positional 로 유지된다", () => {
    const res = parseCommand(logsSpec, ["p", "l", "-"]);
    expect(res.error).toBeUndefined();
    expect(res.positional).toContain("-");
  });
});

describe("parseCommand — 미허용 단축 문자는 미지원 플래그로 거부된다 (unknown-flag 대조군)", () => {
  it("`-z`(미매칭 short) 는 error.kind==='unknown-flag'", () => {
    const res = parseCommand(logsSpec, ["p", "l", "-z"]);
    expect(res.error?.kind).toBe("unknown-flag");
  });
});
