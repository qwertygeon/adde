import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { laneAdd, laneShow, LaneConfigError } from "../../src/core/lane-config.js";
import { parseLaneConf, serializeLaneConf } from "../../src/shared/conf.js";
import type { LaneConf } from "../../src/shared/conf.js";
import { lanePaths } from "../../src/shared/paths.js";
import { DEFAULT_AUTOPASS_DENYLIST } from "../../src/shared/deny-match.js";
import { t } from "../../src/shared/i18n.js";

// 017-lane-set D1 (5a AUTHORING) — laneSet 단위(SC-001·002·005~014) + validateLaneConf 추출 후
// laneAdd baseline 회귀. `laneSet`·`validateLaneConf`·`assertSourceFieldConsistency` 는 4단계
// Development 와 PPG-1 병렬 저작 대상 신규 심볼이라, 각 it 내부에서 지연 import 한다 — 미착지 동안
// 개별 테스트만 RED 로 격리되고 파일 전체 수집이 붕괴하지 않는다(PROC-R15).

// i18n 카탈로그 타입은 `en` 리소스에서 파생되므로, 아직 en.ts 에 없는 신규 키(hardDenyReplaced 등)를
// 참조하면 tsc 가 이를 거부한다 — C1(i18n) 착지 전 저작 단계이므로 느슨한 타입으로 캐스팅해 둔다
// (5b 시점엔 C1 이 착지해 실제 키가 존재 — 캐스팅은 그때도 유효하게 동작한다).
const tAny = t as unknown as (key: string, params?: Record<string, unknown>) => string;

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lane-set-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

async function loadCore() {
  return import("../../src/core/lane-config.js");
}

describe("laneSet 부분 갱신 (SC-001)", () => {
  it("지정한 필드(cwd)만 갱신되고 나머지(perm_tier·source)는 편집 전 값 그대로다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane001", {
      base,
      source: "markdown",
      perm_tier: "acp",
      cwd: "/tmp/a",
    });

    const result = await laneSet("proj", "lane001", { base, cwd: "/tmp/b" });

    expect(result.conf.cwd).toBe("/tmp/b");
    expect(result.conf.perm_tier).toBe("acp");
    expect(result.conf.source).toBe("markdown");

    const shown = await laneShow("proj", "lane001", { base });
    expect(shown.conf.cwd).toBe("/tmp/b");
    expect(shown.conf.perm_tier).toBe("acp");
  });
});

describe("허용 필드 편집 (SC-002)", () => {
  it("file_mode·lang 편집이 반영되고 재파싱 결과가 일치한다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane002", { base, source: "markdown" });

    const result = await laneSet("proj", "lane002", { base, file_mode: "shared", lang: "ko" });

    expect(result.conf.file_mode).toBe("shared");
    expect(result.conf.lang).toBe("ko");
    const reparsed = parseLaneConf(fs.readFileSync(result.confPath, "utf8"));
    expect(reparsed.file_mode).toBe("shared");
    expect(reparsed.lang).toBe("ko");
  });
});

describe("미편집 영속 필드 보존 (SC-005)", () => {
  it("auto_relaunch=false·gate_timeout_sec·denylist 은 cwd 만 편집해도 그대로 보존된다", async () => {
    const { laneSet } = await loadCore();
    // gate_timeout_sec·auto_relaunch=false 는 laneAdd 옵션에 없는 필드라 conf 를 직접 기록한다
    // (research.md §C 라운드트립 보존 근거 — parseLaneConf↔serializeLaneConf 왕복 특성 활용).
    const paths = lanePaths(base, "proj", "lane005");
    fs.mkdirSync(paths.lanesDir, { recursive: true });
    const fixture: LaneConf = {
      source: "markdown",
      backend: "acp",
      engine: "claude-agent-acp",
      perm_tier: "acp",
      acp_version: "v1",
      allowlist: [],
      denylist: ["Bash(sudo *)"],
      hard_deny: [],
      auto_relaunch: false,
      gate_timeout_sec: 300,
    };
    fs.writeFileSync(paths.confFile, serializeLaneConf(fixture));

    const result = await laneSet("proj", "lane005", { base, cwd: "/tmp/z" });

    expect(result.conf.cwd).toBe("/tmp/z");
    expect(result.conf.auto_relaunch).toBe(false);
    expect(result.conf.gate_timeout_sec).toBe(300);
    expect(result.conf.denylist).toEqual(["Bash(sudo *)"]);
  });
});

describe("재검증 수행 (SC-006)", () => {
  it("engine_args 에 따옴표가 포함되면 parseEngineArgs 재검증 실패로 거부된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane006", { base });

    await expect(laneSet("proj", "lane006", { base, engine_args: '"quoted"' })).rejects.toThrow(
      LaneConfigError,
    );
  });
});

describe("검증 실패 무손상 (SC-007)", () => {
  it("잘못된 file_mode 편집은 거부되고 conf 파일이 바이트 단위로 그대로 남는다", async () => {
    const { laneSet } = await loadCore();
    const { confPath } = await laneAdd("proj", "lane007", { base, cwd: "/orig" });
    const before = fs.readFileSync(confPath, "utf8");

    await expect(laneSet("proj", "lane007", { base, file_mode: "bogus" })).rejects.toThrow(
      LaneConfigError,
    );

    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });
});

describe("미존재 레인 (SC-008)", () => {
  it("존재하지 않는 레인 편집은 laneNotFound 계열 오류로 거부된다", async () => {
    const { laneSet } = await loadCore();
    await expect(laneSet("proj", "nope008", { base, cwd: "/x" })).rejects.toThrow(LaneConfigError);
  });
});

describe("no-op 방지 (SC-009)", () => {
  it("편집 플래그가 하나도 없으면 거부되고 conf 는 변경되지 않는다", async () => {
    const { laneSet } = await loadCore();
    const { confPath } = await laneAdd("proj", "lane009", { base });
    const before = fs.readFileSync(confPath, "utf8");

    await expect(laneSet("proj", "lane009", { base })).rejects.toThrow(LaneConfigError);

    expect(fs.readFileSync(confPath, "utf8")).toBe(before);
  });
});

describe("교차소스 하드 거부 (SC-010)", () => {
  it("markdown 레인에 telegram 전용 필드(chat_id) 편집은 거부된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane010a", { base, source: "markdown" });

    await expect(laneSet("proj", "lane010a", { base, chat_id: "123" })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("telegram 레인에 markdown 전용 필드(root) 편집은 거부된다(대칭)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane010b", { base, source: "telegram", chat_id: "1" });

    await expect(laneSet("proj", "lane010b", { base, root: "/v" })).rejects.toThrow(
      LaneConfigError,
    );
  });
});

describe("리스트 치환 (SC-011)", () => {
  it("allowlist 편집은 전체를 치환한다(기존 값 미보존)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane011", { base, allowlist: ["A", "B"] });

    const result = await laneSet("proj", "lane011", { base, allowlist: ["C"] });

    expect(result.conf.allowlist).toEqual(["C"]);
  });
});

describe("autopass denylist 자동충전 (SC-012)", () => {
  it("acp→autopass 전환 시 denylist 미지정·기존 빈값이면 기본 denylist 를 충전한다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane012", { base, perm_tier: "acp" });

    const result = await laneSet("proj", "lane012", { base, perm_tier: "autopass" });

    expect(result.conf.denylist).toEqual([...DEFAULT_AUTOPASS_DENYLIST]);
  });
});

describe("사전 검증 경고 (SC-013)", () => {
  it("acp→autopass 편집은 lane add 와 동일한 autopass 배너 경고를 포함한다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane013", { base, perm_tier: "acp" });

    const result = await laneSet("proj", "lane013", { base, perm_tier: "autopass" });

    // autopassBanner 는 collectAddWarnings 가 이미 소유한 기존 키(laneAdd 공유) — set 도 동일 경고를 낸다.
    expect(result.warnings).toContain(tAny("laneConfig.warn.autopassBanner"));
  });
});

describe("hard_deny 치환 경고 (SC-014)", () => {
  it("hard_deny 치환은 값이 갱신되고 기존 값 대체 경고가 포함된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane014", { base, hard_deny: ["Bash(sudo *)"] });

    const result = await laneSet("proj", "lane014", { base, hard_deny: ["Bash(rm *)"] });

    expect(result.conf.hard_deny).toEqual(["Bash(rm *)"]);
    expect(result.warnings).toContain(tAny("laneConfig.warn.hardDenyReplaced"));
  });

  it("기존 hard_deny 가 비어 있으면 치환 경고가 없다(ADR-007 — 비어있지 않을 때만 경고)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane014b", { base });

    const result = await laneSet("proj", "lane014b", { base, hard_deny: ["Bash(rm *)"] });

    expect(result.warnings).not.toContain(tAny("laneConfig.warn.hardDenyReplaced"));
  });
});

describe("명명플래그 경로 set-시점 정규화 (점표기와 대칭)", () => {
  it("--cwd 류 typed 경로도 반환 conf 에서 셸 이스케이프가 정규화돼 있다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanepath1", { base });

    const result = await laneSet("proj", "lanepath1", { base, cwd: "/tmp/My\\ Folder" });

    // 점표기(parseSchemaValue)와 동일하게 set-시점 정규화 — reparse 전 반환값부터 일치.
    expect(result.conf.cwd).toBe("/tmp/My Folder");
  });

  it("점표기 경로 편집과 결과가 동일하다(대칭 확인)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanepath2", { base });

    const viaDot = await laneSet("proj", "lanepath2", {
      base,
      edits: [{ key: "cwd", value: "/tmp/My\\ Folder" }],
    });

    expect(viaDot.conf.cwd).toBe("/tmp/My Folder");
  });
});

describe("티어↔목록 정합 하드 거부", () => {
  it("유효 acp 에서 denylist 를 명시 지정하면 거부한다(denylist no-op)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanet1", { base, perm_tier: "acp" });
    await expect(laneSet("proj", "lanet1", { base, denylist: ["Bash(sudo *)"] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("유효 autopass 에서 allowlist 를 명시 지정하면 거부한다(allowlist no-op)", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanet2", { base, perm_tier: "autopass" });
    await expect(laneSet("proj", "lanet2", { base, allowlist: ["Read"] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("같은 명령에서 perm_tier=autopass 와 denylist 를 함께 지정하면 허용한다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanet3", { base, perm_tier: "acp" });
    const result = await laneSet("proj", "lanet3", {
      base,
      perm_tier: "autopass",
      denylist: ["Bash(sudo *)"],
    });
    expect(result.conf.denylist).toEqual(["Bash(sudo *)"]);
  });

  it("빈 목록(초기화)은 티어 불일치여도 거부하지 않는다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lanet4", { base, perm_tier: "acp" });
    const result = await laneSet("proj", "lanet4", { base, denylist: [] });
    expect(result.conf.denylist).toEqual([]);
  });
});

// ── laneAdd baseline 회귀 (validateLaneConf 추출, GAP-001 해소 지침 대응) ──────────────────
// research.md §B: 여러 무효 필드가 동시에 있으면 canonical 순서상 첫 위반만 throw 한다.
// 순서 = chat_id → token(telegram전용) → allow_from(telegram전용) → file_mode → allowlist →
// denylist → hard_deny → engine_args → validateEngineWiring → descriptor.validate.
// 아래는 현재(추출 전) 코드에서도 참인 특성화이며, validateLaneConf 추출 후에도 GREEN 이어야
// baseline 회귀 0 이 확정된다(추출 전/후 공통 계약 — laneAdd 는 static import 라 신규 심볼 미착지 리스크 없음).
describe("laneAdd baseline 회귀 (validateLaneConf 추출)", () => {
  it("chat_id·file_mode 동시 위반 시 chat_id(순번 1) 가 먼저 throw 된다", async () => {
    let caught: unknown;
    try {
      await laneAdd("proj", "baseline1", { base, chat_id: "abc", file_mode: "bogus" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LaneConfigError);
    expect((caught as Error).message).toContain("abc");
    expect((caught as Error).message).not.toContain("bogus");
  });

  it("file_mode·allowlist 동시 위반 시 file_mode(순번 4) 가 먼저 throw 된다", async () => {
    let caught: unknown;
    try {
      await laneAdd("proj", "baseline2", { base, file_mode: "bogus", allowlist: ["bad tool!"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LaneConfigError);
    expect((caught as Error).message).toContain("bogus");
  });

  it("allowlist·denylist 동시 위반 시 allowlist(순번 5) 가 먼저 throw 된다", async () => {
    let caught: unknown;
    try {
      await laneAdd("proj", "baseline3", {
        base,
        allowlist: ["bad tool!"],
        denylist: ["bad,entry"],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LaneConfigError);
    expect((caught as Error).message).toContain("bad tool!");
  });

  it("denylist·engine_args 동시 위반 시 denylist(순번 6) 가 먼저 throw 된다(engine_args 는 미도달)", async () => {
    let caught: unknown;
    try {
      await laneAdd("proj", "baseline4", {
        base,
        denylist: ["bad,entry"],
        engine_args: '"quoted"',
      } as Parameters<typeof laneAdd>[2]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LaneConfigError);
    expect((caught as Error).message).not.toContain("quoted");
  });
});
