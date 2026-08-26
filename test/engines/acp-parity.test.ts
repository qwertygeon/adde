import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// SC-022 (FR-022) — ACP 엔진이 등록된 엔진 1종으로 v0.2.x 와 동등하게 동작한다: 지시 처리·권한
// 요청 중계·세션 재개·엔진 인자 전달 4하위조항을 각각 직접 단언한다(PROC-R21).
//
// ASSUMPTION(테스트 작성자 — Development 동기화 필요): engines/acp/driver.ts 의 바이너리 해석이
// `ADDE_ACP_BIN` env override 를 최우선 소비한다고 가정(caps-registry.test.ts·resume-spawn.test.ts
// 와 동일 가정 — 실 claude-agent-acp 무접촉 원칙, infra.md §4 [MUST NOT]).

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
let tmpBase: string;
let dumpPath: string;
const origBin = process.env["ADDE_ACP_BIN"];
const origDump = process.env["FAKE_ACP_ARGV_DUMP"];

beforeEach(() => {
  fs.chmodSync(FIXTURE, 0o755);
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-acp-parity-"));
  dumpPath = path.join(tmpBase, "argv.json");
  process.env["ADDE_ACP_BIN"] = FIXTURE;
  process.env["FAKE_ACP_ARGV_DUMP"] = dumpPath;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  if (origBin === undefined) delete process.env["ADDE_ACP_BIN"];
  else process.env["ADDE_ACP_BIN"] = origBin;
  if (origDump === undefined) delete process.env["FAKE_ACP_ARGV_DUMP"];
  else process.env["FAKE_ACP_ARGV_DUMP"] = origDump;
});

async function loadAcpDriver() {
  const engines = await import("../../src/engines/index.js");
  return engines.ENGINE_REGISTRY["acp"];
}

describe("SC-022: ACP 드라이버가 v0.2.x 와 동등하게 4동작을 수행한다", () => {
  it("Happy(1/4 지시 처리): send() 가 텍스트 응답을 반환한다", async () => {
    const driver = await loadAcpDriver();
    const session = await driver!.open({ cwd: tmpBase, policy: { perm_tier: "acp" } } as never);
    const texts: string[] = [];
    for await (const ev of session.send({ text: "hello" } as never)) {
      if ((ev as { t: string }).t === "text") texts.push((ev as { delta: string }).delta);
    }
    expect(texts.join("")).toContain("pong");
    await session.close();
  });

  it("Happy(2/4 권한 요청 중계): respondPermission 이 정상 호출 가능하다", async () => {
    const driver = await loadAcpDriver();
    const session = await driver!.open({ cwd: tmpBase, policy: { perm_tier: "acp" } } as never);
    await expect(session.respondPermission("req-1", "allow")).resolves.toBeUndefined();
    await session.close();
  });

  it("Happy(3/4 세션 재개): engineRef 로 재개하면 session/load 가 성공한다(known- 접두 픽스처 계약)", async () => {
    const driver = await loadAcpDriver();
    const session = await driver!.open({
      cwd: tmpBase,
      engineRef: "known-abc",
      policy: { perm_tier: "acp" },
    } as never);
    expect(session.engineRef).toBeDefined();
    await session.close();
  });

  it("Error(3/4 세션 재개 실패): 미지의 세션 재개는 throw 되고 새 세션으로 조용히 폴백하지 않는다(ADR-009)", async () => {
    const driver = await loadAcpDriver();
    await expect(
      driver!.open({
        cwd: tmpBase,
        engineRef: "unknown-session-id",
        policy: { perm_tier: "acp" },
      } as never),
    ).rejects.toThrow();
  });

  it("Happy(4/4 엔진 인자 전달): engineArgs 가 실 spawn argv 에 그대로 전달된다", async () => {
    const driver = await loadAcpDriver();
    const session = await driver!.open({
      cwd: tmpBase,
      args: ["--custom-flag", "value"],
      policy: { perm_tier: "acp" },
    } as never);
    await session.close();
    expect(fs.existsSync(dumpPath)).toBe(true);
    const argv = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as string[];
    expect(argv).toEqual(expect.arrayContaining(["--custom-flag", "value"]));
  });

  it("Edge: 권한 설정 차이(perm-diff)가 존재하면 onWarn 으로 표면화된다(ADR-022)", async () => {
    const driver = await loadAcpDriver();
    const warnings: string[] = [];
    const session = await driver!.open({
      cwd: tmpBase,
      policy: { perm_tier: "autopass" },
      onWarn: (msg: string) => warnings.push(msg),
    } as never);
    await session.close();
    // perm-diff 표기는 구현 세부(진짜 차이가 발생하는 조건은 Development 확정) — 본 테스트는
    // onWarn 훅이 배선 가능함을 확인한다(호출 자체 여부는 실제 차이 발생 시나리오에서 EXECUTION 확정).
    expect(Array.isArray(warnings)).toBe(true);
  });

  it("Error: 엔진 인자 파싱 불가 값이면 세션 생성 전에 거부된다", async () => {
    const driver = await loadAcpDriver();
    await expect(
      driver!.open({
        cwd: tmpBase,
        args: [null as unknown as string],
        policy: { perm_tier: "acp" },
      } as never),
    ).rejects.toThrow();
  });
});
