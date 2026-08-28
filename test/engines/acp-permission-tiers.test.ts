import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// 권한 세 등급 중 하드 차단·자동 허용은 드라이버가 즉시 반환하면서 코어에 아무것도 넘기지 않아
// 기록이 남지 않았다 — 모델이 "권한이 없다" 고 말해도 ADDE 정책이 막았다는 사실을 알 수 없어 정책
// 오설정을 진단할 수 없다. 차단·허용 동작은 그대로 두고 기록만 추가했음을 실 드라이버로 확인한다.

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
let tmpBase: string;
let outcomeDump: string;
const origEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ADDE_ACP_BIN",
  "FAKE_ACP_PERM_TOOL",
  "FAKE_ACP_PERM_INPUT",
  "FAKE_ACP_PERM_OUTCOME_DUMP",
  "FAKE_ACP_MODE_UPDATE",
];

beforeEach(() => {
  fs.chmodSync(FIXTURE, 0o755);
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-perm-tiers-"));
  outcomeDump = path.join(tmpBase, "outcome.jsonl");
  for (const k of ENV_KEYS) origEnv[k] = process.env[k];
  process.env["ADDE_ACP_BIN"] = FIXTURE;
  process.env["FAKE_ACP_PERM_TOOL"] = "Bash";
  process.env["FAKE_ACP_PERM_OUTCOME_DUMP"] = outcomeDump;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function collectEvents(
  policy: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const engines = await import("../../src/engines/index.js");
  const driver = engines.ENGINE_REGISTRY["acp"]!;
  const session = await driver.open({ cwd: tmpBase, policy } as never);
  const events: Array<Record<string, unknown>> = [];
  try {
    for await (const ev of session.send({ text: "hello" } as never)) {
      events.push(ev as unknown as Record<string, unknown>);
    }
  } finally {
    await session.close();
  }
  return events;
}

function outcomes(): Array<Record<string, unknown>> {
  if (!fs.existsSync(outcomeDump)) return [];
  return fs
    .readFileSync(outcomeDump, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("권한 세 등급의 기록", () => {
  it("Happy(하드 차단): 차단은 그대로 하고 결정 이벤트를 남긴다", async () => {
    const events = await collectEvents({
      perm_tier: "acp",
      allowlist: [],
      denylist: [],
      hard_deny: ["Bash"],
    });
    const resolved = events.find((e) => e["t"] === "permission_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!["decision"]).toBe("deny");
    expect(resolved!["via"]).toBe("hard_deny");
    // 승인 요청을 채널로 올리지 않는다(하드 차단은 프롬프트 없이 거부).
    expect(events.some((e) => e["t"] === "permission")).toBe(false);
    // 엔진에는 여전히 취소가 전달돼야 한다(동작 불변).
    expect(outcomes()[0]?.["outcome"]).toMatchObject({ outcome: "cancelled" });
  }, 30_000);

  it("Happy(허용 목록 자동 허용): 자동 허용도 결정 경로와 함께 기록된다", async () => {
    const events = await collectEvents({
      perm_tier: "acp",
      allowlist: ["Bash"],
      denylist: [],
      hard_deny: [],
    });
    const resolved = events.find((e) => e["t"] === "permission_resolved");
    expect(resolved).toBeDefined();
    expect(resolved!["decision"]).toBe("allow");
    expect(resolved!["via"]).toBe("allowlist");
    expect(outcomes()[0]?.["outcome"]).toMatchObject({ outcome: "selected" });
  }, 30_000);

  it("Happy(autopass 자동 허용): 티어 유래 자동 허용이 구분되어 기록된다", async () => {
    const events = await collectEvents({
      perm_tier: "autopass",
      allowlist: [],
      denylist: [],
      hard_deny: [],
    });
    const resolved = events.find((e) => e["t"] === "permission_resolved");
    expect(resolved!["via"]).toBe("autopass");
    expect(resolved!["decision"]).toBe("allow");
  }, 30_000);

  it("Edge(채널 승인 대상): 정책이 결정하지 않으면 승인 요청 이벤트로 올린다", async () => {
    const engines = await import("../../src/engines/index.js");
    const driver = engines.ENGINE_REGISTRY["acp"]!;
    const session = await driver.open({
      cwd: tmpBase,
      policy: { perm_tier: "acp", allowlist: [], denylist: [], hard_deny: [] },
    } as never);
    const seen: Array<Record<string, unknown>> = [];
    try {
      for await (const ev of session.send({ text: "hello" } as never)) {
        const e = ev as unknown as Record<string, unknown>;
        seen.push(e);
        if (e["t"] === "permission") {
          // 승인 대기 중인 요청을 거부로 답해 턴을 진행시킨다.
          await session.respondPermission(e["reqId"] as string, "deny");
        }
      }
    } finally {
      await session.close();
    }
    expect(seen.some((e) => e["t"] === "permission")).toBe(true);
    expect(seen.some((e) => e["t"] === "permission_resolved")).toBe(false);
  }, 30_000);

  it("Happy(설정 차이 경고): 차이 경고가 상황 + 조치 2요소로 전달된다", async () => {
    process.env["FAKE_ACP_MODE_UPDATE"] = "bypassPermissions";
    delete process.env["FAKE_ACP_PERM_TOOL"]; // 권한 왕복 없이 모드 알림만
    const engines = await import("../../src/engines/index.js");
    const driver = engines.ENGINE_REGISTRY["acp"]!;
    const warns: string[] = [];
    const session = await driver.open({
      cwd: tmpBase,
      policy: { perm_tier: "acp", allowlist: [], denylist: [], hard_deny: [] },
      onWarn: (msg: string) => warns.push(msg),
    } as never);
    try {
      for await (const _ev of session.send({ text: "hello" } as never)) {
        void _ev;
      }
    } finally {
      await session.close();
    }
    const drift = warns.find((w) => w.includes("조치"));
    expect(drift).toBeDefined();
    expect(drift).toContain("경고");
  }, 30_000);
});
