import { afterEach, describe, expect, it, vi } from "vitest";
import { readVersion } from "../src/core/version.js";
import { COMMANDS, buildUsage } from "../src/core/messages.js";
import { run } from "../src/cli/run.js";

describe("cli usage", () => {
  it("usage 텍스트에 두 명령 표면을 모두 노출한다", () => {
    const usage = buildUsage();
    expect(usage).toContain(COMMANDS.primary);
    expect(usage).toContain(COMMANDS.short);
  });
});

describe("run 최상위 디스패치", () => {
  afterEach(() => vi.restoreAllMocks());

  it("인자 없으면 usage 를 stdout 에 출력하고 0 을 반환한다", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run([]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalled();
  });

  it("-h/--help 은 usage 를 출력하고 0 을 반환한다", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run(["--help"])).toBe(0);
    expect(await run(["-h"])).toBe(0);
  });

  it("미지원 명령은 stderr 에 오류를 내고 1 을 반환한다 (오타 은폐 방지)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await run(["statsu"]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
    const errText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(errText).toContain("statsu");
    expect(errText).toContain("status"); // did-you-mean 힌트
  });

  it("서브커맨드 --help 는 그 명령 usage 를 출력하고 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run(["status", "--help"]);
    expect(code).toBe(0);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("adde status");
  });

  it("completion <shell> 은 스크립트를 stdout 에 출력하고 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run(["completion", "bash"]);
    expect(code).toBe(0);
    const text = out.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("complete -F _adde adde ad add");
  });

  it("completion 미지원 셸은 stderr + 1", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await run(["completion", "fish"]);
    expect(code).toBe(1);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("fish");
  });

  it("completion 셸 인자 누락은 usage + 2 (SC-006, FR-004 — 위치인자 누락 계약)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await run(["completion"])).toBe(2);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("completion");
  });

  it("init --help 는 init usage 를 출력하고 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run(["init", "--help"]);
    expect(code).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("adde init");
  });

  it("alias --help 는 alias usage 를 출력하고 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await run(["alias", "--help"]);
    expect(code).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("adde alias");
  });

  it("비TTY 에서 init 은 안내 후 1(대화형 필요)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      expect(await run(["init"])).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("TTY");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });

  it("usage 에 init·alias 명령이 노출된다", () => {
    const usage = buildUsage();
    expect(usage).toContain("init");
    expect(usage).toContain("alias");
  });
});

describe("version", () => {
  it("package.json.version(SemVer)을 SoT 로 읽는다", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
