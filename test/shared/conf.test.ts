import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseLaneConf,
  serializeLaneConf,
  detectLegacyAdapterKeys,
  parseKeyValues,
  parseProjConf,
  readProjConf,
} from "../../src/shared/conf.js";
import type { LaneConf } from "../../src/shared/conf.js";

/**
 * 화이트리스트 검증·파싱 헬퍼(validateEngineWiring, resolveEngine, resolveBackend, parseEngineArgs,
 * EngineArgsParseError, DEFAULT_ENGINE 등, KNOWN_ENGINES 등, ACP_VERSION)는 PPG-1 병렬 중 4단계가
 * 아직 착지하지 않았을 수 있는 신규 심볼이다. 정적 import 로 묶으면 미착지 시 파일 전체 수집이
 * 무너지므로, 각 테스트가 동적 import 로 개별 격리한다(미착지 구간만 해당 테스트 RED).
 */
async function loadConfModule() {
  return import("../../src/shared/conf.js");
}

// parseLaneConf: ini 형식 레인 설정 파싱 — FR-001/021

describe("parseLaneConf", () => {
  const minimalConf = `source=telegram
backend=acp
engine=claude-agent-acp
channel=telegram
`;

  it("필수 필드를 파싱한다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.source).toBe("telegram");
    expect(result.backend).toBe("acp");
    expect(result.engine).toBe("claude-agent-acp");
  });

  it("acp_version 기본값이 v1 이다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.acp_version).toBe("v1");
  });

  it("perm_tier 기본값이 acp 이다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.perm_tier).toBe("acp");
  });

  it("명시된 acp_version 이 기본값을 덮어쓴다", () => {
    const conf = minimalConf + "acp_version=v2\n";
    const result = parseLaneConf(conf);
    expect(result.acp_version).toBe("v2");
  });

  it("알 수 없는 키는 무시한다 (forward-compat)", () => {
    const conf = minimalConf + "unknown_future_key=value\n";
    expect(() => parseLaneConf(conf)).not.toThrow();
  });

  it("allowlist 필드를 파싱한다 (선택 필드)", () => {
    const conf = minimalConf + "allowlist=Bash,Read\n";
    const result = parseLaneConf(conf);
    expect(result.allowlist).toBeDefined();
  });

  it("cwd(프로젝트 폴더) 를 파싱한다 — 미지정 시 undefined", () => {
    expect(parseLaneConf(minimalConf).cwd).toBeUndefined();
    const conf = minimalConf + "cwd=/abs/project/dir\n";
    expect(parseLaneConf(conf).cwd).toBe("/abs/project/dir");
  });

  it("telegram.chat_id 를 문자열로 보존한다 (네임스페이스)", () => {
    const conf = minimalConf + "telegram.chat_id=12345\n";
    expect(parseLaneConf(conf).telegram?.chat_id).toBe("12345");
  });

  it("markdown 네임스페이스 키(markdown.root/inbox/approvals/outbox)를 파싱한다", () => {
    const conf =
      "source=markdown\n" +
      "markdown.root=/abs/Notes\nmarkdown.inbox=adde/L/inbox.md\nmarkdown.approvals=adde/L/approvals.md\nmarkdown.outbox=adde/L/out/\n";
    const result = parseLaneConf(conf);
    expect(result.source).toBe("markdown");
    expect(result.markdown?.root).toBe("/abs/Notes");
    expect(result.markdown?.inbox).toBe("adde/L/inbox.md");
    expect(result.markdown?.approvals).toBe("adde/L/approvals.md");
    expect(result.markdown?.outbox).toBe("adde/L/out/");
  });

  it("관련 네임스페이스 키가 없으면 서브객체는 undefined 다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.markdown).toBeUndefined();
    expect(result.telegram).toBeUndefined();
  });

  it("구 평면 어댑터 키(root=·chat_id=)는 무시한다 (클린 브레이크 — 값 미반영)", () => {
    const conf = "source=markdown\nroot=/abs/Notes\ninbox=in.md\nchat_id=12345\n";
    const result = parseLaneConf(conf);
    expect(result.markdown).toBeUndefined(); // 평면 root/inbox 는 markdown.* 로 안 들어감
    expect(result.telegram).toBeUndefined();
  });

  it("빈 값 optional 키는 undefined 로 둔다", () => {
    const conf = minimalConf + "cwd=\n";
    expect(parseLaneConf(conf).cwd).toBeUndefined();
  });
});

describe("serializeLaneConf", () => {
  it("필수 키를 모두 출력한다", () => {
    const text = serializeLaneConf(parseLaneConf("source=telegram\n"));
    expect(text).toContain("source=telegram");
    expect(text).toContain("backend=");
    expect(text).toContain("engine=");
    expect(text).toContain("perm_tier=acp");
    expect(text).toContain("acp_version=v1");
  });

  it("구 conf 의 channel= 는 무시하고 재직렬화 시 출력하지 않는다(사문화 필드 제거)", () => {
    const text = serializeLaneConf(parseLaneConf("source=telegram\nchannel=telegram\n"));
    expect(text).not.toContain("channel=");
  });

  it("빈 allowlist 는 출력하지 않는다", () => {
    const text = serializeLaneConf(parseLaneConf("source=telegram\n"));
    expect(text).not.toContain("allowlist=");
  });

  it("optional 키는 값이 있을 때만 출력한다", () => {
    const text = serializeLaneConf(parseLaneConf("source=telegram\ncwd=/p\n"));
    expect(text).toContain("cwd=/p");
    expect(text).not.toContain("root=");
    expect(text).not.toContain("chat_id=");
  });

  it("parse→serialize→parse round-trip 이 동치이다 (네임스페이스 키 포함)", () => {
    const original = parseLaneConf(
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\n" +
        "perm_tier=acp\nacp_version=v1\nallowlist=Read,Grep\ncwd=/abs/p\nmarkdown.root=/abs/Notes\nmarkdown.inbox=in.md\n",
    );
    const reparsed = parseLaneConf(serializeLaneConf(original));
    expect(reparsed).toEqual(original);
    expect(reparsed.markdown?.root).toBe("/abs/Notes");
  });

  it("telegram 네임스페이스 round-trip 이 동치이다", () => {
    const original = parseLaneConf(
      "source=telegram\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n" +
        "telegram.chat_id=12345\ntelegram.allow_from=111,222\n",
    );
    const reparsed = parseLaneConf(serializeLaneConf(original));
    expect(reparsed).toEqual(original);
    expect(reparsed.telegram?.chat_id).toBe("12345");
    expect(reparsed.telegram?.allow_from).toBe("111,222");
  });
});

// backup/retention_days/out_retention_days/sync_provider — 파싱측 opt-in·정수 필드 계약(SC-017 파싱측).
describe("markdown 백업/이관 설정 파싱 (backup·retention_days·out_retention_days·sync_provider)", () => {
  const base = "source=markdown\nmarkdown.root=/abs/Notes\nmarkdown.inbox=in.md\n";

  it("미지정 시 네 필드 모두 undefined 다(opt-in, 기본값은 소비측 적용)", () => {
    const result = parseLaneConf(base);
    expect(result.markdown?.backup).toBeUndefined();
    expect(result.markdown?.retention_days).toBeUndefined();
    expect(result.markdown?.out_retention_days).toBeUndefined();
    expect(result.markdown?.sync_provider).toBeUndefined();
  });

  it("backup 은 문자열 경로 그대로 보존한다(vault 밖·절대경로 포함)", () => {
    const result = parseLaneConf(base + "markdown.backup=/Volumes/Ext/adde-backup\n");
    expect(result.markdown?.backup).toBe("/Volumes/Ext/adde-backup");
  });

  it("retention_days·out_retention_days 는 정수로 파싱된다(gate_timeout_sec 선례 준용)", () => {
    const result = parseLaneConf(
      base + "markdown.retention_days=2\nmarkdown.out_retention_days=5\n",
    );
    expect(result.markdown?.retention_days).toBe(2);
    expect(result.markdown?.out_retention_days).toBe(5);
  });

  it("무효/0/음수 retention_days 는 무시되어 undefined 로 남는다(소비측 기본값 적용 위임)", () => {
    expect(parseLaneConf(base + "markdown.retention_days=0\n").markdown?.retention_days).toBeUndefined();
    expect(
      parseLaneConf(base + "markdown.retention_days=-1\n").markdown?.retention_days,
    ).toBeUndefined();
    expect(
      parseLaneConf(base + "markdown.retention_days=abc\n").markdown?.retention_days,
    ).toBeUndefined();
  });

  it("sync_provider 는 문자열 그대로 보존한다(허용값 검증은 기동 시점 — 파서는 미검증)", () => {
    expect(parseLaneConf(base + "markdown.sync_provider=icloud\n").markdown?.sync_provider).toBe(
      "icloud",
    );
    // 파서는 검증하지 않음 — 미지원 값도 그대로 통과, 거부는 C-01 기동 검증 책임.
    expect(parseLaneConf(base + "markdown.sync_provider=gdrive\n").markdown?.sync_provider).toBe(
      "gdrive",
    );
  });

  it("parse→serialize→parse round-trip 이 네 필드 모두에 대해 동치이다", () => {
    const original = parseLaneConf(
      base +
        "markdown.backup=/abs/Backup\nmarkdown.retention_days=3\nmarkdown.out_retention_days=7\nmarkdown.sync_provider=icloud\n",
    );
    const reparsed = parseLaneConf(serializeLaneConf(original));
    expect(reparsed).toEqual(original);
    expect(reparsed.markdown?.retention_days).toBe(3);
  });
});

describe("gate_timeout_sec (F12a 옵트인 게이트 타임아웃)", () => {
  it("미지정 시 undefined (기본 600초는 소비측이 적용)", () => {
    expect(parseLaneConf("source=telegram\n").gate_timeout_sec).toBeUndefined();
  });

  it("양의 정수를 초 단위로 파싱한다", () => {
    expect(parseLaneConf("source=telegram\ngate_timeout_sec=120\n").gate_timeout_sec).toBe(120);
  });

  it("0·음수·비수치는 무시한다 (undefined → 기본값 폴백)", () => {
    expect(parseLaneConf("source=telegram\ngate_timeout_sec=0\n").gate_timeout_sec).toBeUndefined();
    expect(
      parseLaneConf("source=telegram\ngate_timeout_sec=-5\n").gate_timeout_sec,
    ).toBeUndefined();
    expect(
      parseLaneConf("source=telegram\ngate_timeout_sec=abc\n").gate_timeout_sec,
    ).toBeUndefined();
  });

  it("값이 있을 때만 직렬화하고 round-trip 이 동치이다", () => {
    expect(serializeLaneConf(parseLaneConf("source=telegram\n"))).not.toContain(
      "gate_timeout_sec=",
    );
    const original = parseLaneConf("source=telegram\ngate_timeout_sec=300\n");
    expect(serializeLaneConf(original)).toContain("gate_timeout_sec=300");
    expect(parseLaneConf(serializeLaneConf(original))).toEqual(original);
  });
});

describe("detectLegacyAdapterKeys", () => {
  it("구 평면 어댑터 키를 감지한다 (마이그레이션 경고용)", () => {
    const conf = "source=markdown\nroot=/abs/Notes\ninbox=in.md\nchat_id=12345\n";
    const found = detectLegacyAdapterKeys(conf);
    expect(found).toEqual(expect.arrayContaining(["root", "inbox", "chat_id"]));
  });

  it("네임스페이스 키만 있으면 빈 배열이다 (신규 포맷)", () => {
    const conf = "source=markdown\nmarkdown.root=/abs/Notes\nmarkdown.inbox=in.md\n";
    expect(detectLegacyAdapterKeys(conf)).toEqual([]);
  });

  it("어댑터 키가 없으면 빈 배열이다", () => {
    expect(detectLegacyAdapterKeys("source=telegram\nbackend=acp\n")).toEqual([]);
  });
});

// SC-012(NFR-005 — 하위호환)·SC-015(FR-008 — ON 경로): auto_relaunch 는 명시 "false" 만 OFF,
// 그 외(부재·true·빈값·무효값)는 ON(default-on·forward-compat). 002-lane-engine-recovery.
describe("auto_relaunch (FR-008 자가 재기동 opt-out 노브)", () => {
  it("키가 없으면 true(ON, default-on) — 기존 conf 하위호환 (SC-012 Happy)", () => {
    expect(parseLaneConf("source=telegram\n").auto_relaunch).toBe(true);
  });

  it("명시 false 만 OFF — 무효/빈/대문자 값은 ON(forward-compat) (SC-012 Edge)", () => {
    expect(parseLaneConf("source=telegram\nauto_relaunch=false\n").auto_relaunch).toBe(false);
    expect(parseLaneConf("source=telegram\nauto_relaunch=true\n").auto_relaunch).toBe(true);
    expect(parseLaneConf("source=telegram\nauto_relaunch=maybe\n").auto_relaunch).toBe(true);
    expect(parseLaneConf("source=telegram\nauto_relaunch=\n").auto_relaunch).toBe(true);
    expect(parseLaneConf("source=telegram\nauto_relaunch=TRUE\n").auto_relaunch).toBe(true);
    expect(parseLaneConf("source=telegram\nauto_relaunch=FALSE\n").auto_relaunch).toBe(false);
  });

  it("true 는 직렬화 시 라인을 출력하지 않는다(churn 0) — false 만 출력 (SC-015 Edge)", () => {
    const onText = serializeLaneConf(parseLaneConf("source=telegram\n"));
    expect(onText).not.toContain("auto_relaunch=");

    const offText = serializeLaneConf(parseLaneConf("source=telegram\nauto_relaunch=false\n"));
    expect(offText).toContain("auto_relaunch=false");
  });

  it("round-trip 이 동치이다(true/false 양쪽) (SC-015 Edge)", () => {
    const onOriginal = parseLaneConf("source=telegram\n");
    expect(parseLaneConf(serializeLaneConf(onOriginal))).toEqual(onOriginal);
    expect(parseLaneConf(serializeLaneConf(onOriginal)).auto_relaunch).toBe(true);

    const offOriginal = parseLaneConf("source=telegram\nauto_relaunch=false\n");
    expect(parseLaneConf(serializeLaneConf(offOriginal))).toEqual(offOriginal);
    expect(parseLaneConf(serializeLaneConf(offOriginal)).auto_relaunch).toBe(false);
  });

  it("기존 v:1 레인(auto_relaunch 키 부재)이 정상 파싱된다 — 필수 필드화로 파손 없음 (SC-012)", () => {
    const legacyConf =
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n" +
      "markdown.root=/abs/Notes\nmarkdown.inbox=in.md\n";
    const result = parseLaneConf(legacyConf);
    expect(result.auto_relaunch).toBe(true);
    expect(result.markdown?.root).toBe("/abs/Notes"); // 기존 필드 파손 없음
  });
});

describe("denylist (005 autopass)", () => {
  it("denylist 를 콤마 목록으로 파싱하고, 미지정 시 빈 배열이다", () => {
    expect(parseLaneConf("source=telegram\n").denylist).toEqual([]);
    const result = parseLaneConf("source=telegram\ndenylist=Bash, Write\n");
    expect(result.denylist).toEqual(["Bash", "Write"]);
  });

  it("denylist 는 비어있지 않을 때만 직렬화한다", () => {
    expect(serializeLaneConf(parseLaneConf("source=telegram\n"))).not.toContain("denylist=");
    expect(serializeLaneConf(parseLaneConf("source=telegram\ndenylist=Bash\n"))).toContain(
      "denylist=Bash",
    );
  });

  it("denylist 포함 parse→serialize→parse round-trip 이 동치이다", () => {
    const original = parseLaneConf(
      "source=telegram\nperm_tier=autopass\nallowlist=Read\ndenylist=Bash,Write\n",
    );
    expect(parseLaneConf(serializeLaneConf(original))).toEqual(original);
  });
});

// SC-017 (FR-016): proj.conf 의 auto_restart 파싱 — 기본 on·명시 false 만 off·무효/부재 fallback.
// auto_relaunch(레인 conf) 파싱 선례 준용(parseKeyValues 재사용, export 승격).

describe("parseKeyValues (export 승격 — parseProjConf 가 재사용하는 SoT)", () => {
  it("key=value 라인을 파싱하고 주석·빈 줄을 무시한다", () => {
    const kv = parseKeyValues("# comment\nauto_restart=false\n\n; also comment\nfoo=bar\n");
    expect(kv["auto_restart"]).toBe("false");
    expect(kv["foo"]).toBe("bar");
  });
});

describe("parseProjConf (SC-017 — (b)(c)(d)(e))", () => {
  it("(b) auto_restart 키 부재 → on(true)", () => {
    expect(parseProjConf("").auto_restart).toBe(true);
    expect(parseProjConf("other_key=value\n").auto_restart).toBe(true);
  });

  it("(c) auto_restart=false 명시 → off(false)", () => {
    expect(parseProjConf("auto_restart=false\n").auto_restart).toBe(false);
  });

  it("(d) auto_restart=true 명시 → on(true)", () => {
    expect(parseProjConf("auto_restart=true\n").auto_restart).toBe(true);
  });

  it("(e) 무효값(예: maybe) → on(true) — fallback(auto_relaunch 선례 준용)", () => {
    expect(parseProjConf("auto_restart=maybe\n").auto_restart).toBe(true);
    expect(parseProjConf("auto_restart=\n").auto_restart).toBe(true);
    expect(parseProjConf("auto_restart=FALSE\n").auto_restart).toBe(false); // 대소문자 무관 false 인식
    expect(parseProjConf("auto_restart=TRUE\n").auto_restart).toBe(true);
  });
});

describe("readProjConf (SC-017 — (a) 파일 부재)", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-proj-conf-"));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("(a) proj.conf 파일 부재 → 기본 on(true)", async () => {
    const conf = await readProjConf(tmpBase, "myproj");
    expect(conf.auto_restart).toBe(true);
  });

  it("proj.conf 존재 + auto_restart=false → off(false)", async () => {
    const projDir = path.join(tmpBase, "myproj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "proj.conf"), "auto_restart=false\n");

    const conf = await readProjConf(tmpBase, "myproj");
    expect(conf.auto_restart).toBe(false);
  });

  it("proj.conf 존재 + 키 부재 → on(true)", async () => {
    const projDir = path.join(tmpBase, "myproj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "proj.conf"), "# no auto_restart key\n");

    const conf = await readProjConf(tmpBase, "myproj");
    expect(conf.auto_restart).toBe(true);
  });
});

// ── 016-engine-wiring ────────────────────────────────────────────────────

describe("engine_args 필드 파싱·직렬화", () => {
  const base =
    "source=telegram\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n";

  it("engine_args 를 raw 문자열 그대로 보존한다", () => {
    const result = parseLaneConf(base + "engine_args=--model opus\n");
    expect(result.engine_args).toBe("--model opus");
  });

  it("engine_args 미지정 시 undefined 다", () => {
    expect(parseLaneConf(base).engine_args).toBeUndefined();
  });

  it("engine_args 부재 conf 는 직렬화에 라인을 출력하지 않는다(churn 0)", () => {
    const original = parseLaneConf(base);
    expect(serializeLaneConf(original)).not.toContain("engine_args=");
  });

  it("engine_args 는 COMMON_OPTIONAL_KEYS 중 마지막에 직렬화된다(cwd 뒤)", () => {
    const original = parseLaneConf(base + "cwd=/abs/p\nengine_args=--model opus\n");
    const text = serializeLaneConf(original);
    expect(text.indexOf("cwd=")).toBeGreaterThan(-1);
    expect(text.indexOf("engine_args=")).toBeGreaterThan(text.indexOf("cwd="));
  });

  it("engine_args 부재/포함 양쪽 모두 round-trip 이 동치이다", () => {
    const withoutArgs = parseLaneConf(base);
    expect(parseLaneConf(serializeLaneConf(withoutArgs))).toEqual(withoutArgs);

    const withArgs = parseLaneConf(base + "engine_args=--model opus --temperature 0.2\n");
    expect(parseLaneConf(serializeLaneConf(withArgs))).toEqual(withArgs);
    expect(parseLaneConf(serializeLaneConf(withArgs)).engine_args).toBe(
      "--model opus --temperature 0.2",
    );
  });
});

describe("validateEngineWiring — engine 화이트리스트 (SC-001/SC-002)", () => {
  const makeConf = (overrides: Partial<LaneConf> = {}): LaneConf => ({
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
    perm_tier: "acp",
    acp_version: "v1",
    allowlist: [],
    denylist: [],
    hard_deny: [],
    auto_relaunch: true,
    ...overrides,
  });

  it("미지원/오타 engine 은 {code:'engine', value} 위반을 반환한다 (SC-001 Error)", async () => {
    const { validateEngineWiring } = await loadConfModule();
    expect(validateEngineWiring(makeConf({ engine: "codex-acp" }))).toEqual({
      code: "engine",
      value: "codex-acp",
    });
    expect(validateEngineWiring(makeConf({ engine: "clade" }))).toEqual({
      code: "engine",
      value: "clade",
    });
  });

  it("알려진 engine(claude-agent-acp)은 null 을 반환한다 (SC-002 Happy)", async () => {
    const { validateEngineWiring } = await loadConfModule();
    expect(validateEngineWiring(makeConf({ engine: "claude-agent-acp" }))).toBeNull();
  });
});

describe("validateEngineWiring — backend 화이트리스트 (SC-003/SC-004)", () => {
  const makeConf = (overrides: Partial<LaneConf> = {}): LaneConf => ({
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
    perm_tier: "acp",
    acp_version: "v1",
    allowlist: [],
    denylist: [],
    hard_deny: [],
    auto_relaunch: true,
    ...overrides,
  });

  it("미지원/오타 backend 는 {code:'backend', value} 위반을 반환한다 (SC-003 Error)", async () => {
    const { validateEngineWiring } = await loadConfModule();
    expect(validateEngineWiring(makeConf({ backend: "rest" }))).toEqual({
      code: "backend",
      value: "rest",
    });
  });

  it("알려진 backend(acp)는 null 을 반환한다 (SC-004 Happy)", async () => {
    const { validateEngineWiring } = await loadConfModule();
    expect(validateEngineWiring(makeConf({ backend: "acp" }))).toBeNull();
  });
});

describe("resolveEngine/resolveBackend 기본값 해석 — 두 계층 단일화 근거 (SC-005)", () => {
  it("resolveEngine(undefined|빈값) 는 DEFAULT_ENGINE 이다", async () => {
    const { resolveEngine, DEFAULT_ENGINE } = await loadConfModule();
    expect(resolveEngine(undefined)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine("")).toBe(DEFAULT_ENGINE);
  });

  it("resolveEngine(값)은 비어있지 않으면 그 값을 그대로 반환한다", async () => {
    const { resolveEngine } = await loadConfModule();
    expect(resolveEngine("claude-agent-acp")).toBe("claude-agent-acp");
    expect(resolveEngine("codex-acp")).toBe("codex-acp"); // 검증은 validateEngineWiring 책임 — resolve 는 판정하지 않음
  });

  it("resolveBackend(undefined|빈값) 는 DEFAULT_BACKEND 이다", async () => {
    const { resolveBackend, DEFAULT_BACKEND } = await loadConfModule();
    expect(resolveBackend(undefined)).toBe(DEFAULT_BACKEND);
    expect(resolveBackend("")).toBe(DEFAULT_BACKEND);
  });

  it("DEFAULT_ENGINE·DEFAULT_BACKEND 는 각각 KNOWN_ENGINES·KNOWN_BACKENDS 에 포함된다(자기정합)", async () => {
    const { DEFAULT_ENGINE, DEFAULT_BACKEND, KNOWN_ENGINES, KNOWN_BACKENDS } =
      await loadConfModule();
    expect(KNOWN_ENGINES).toContain(DEFAULT_ENGINE);
    expect(KNOWN_BACKENDS).toContain(DEFAULT_BACKEND);
  });
});

describe("parseEngineArgs — 공백 분리 파싱 (SC-008 Happy·SC-010 Edge·SC-011 Error)", () => {
  it("공백 분리 문자열을 인자 배열로 파싱한다 (SC-008 Happy)", async () => {
    const { parseEngineArgs } = await loadConfModule();
    expect(parseEngineArgs("--model opus")).toEqual(["--model", "opus"]);
    expect(parseEngineArgs("--verbose")).toEqual(["--verbose"]);
  });

  it("미지정/빈값/공백-only 는 빈 배열이다 (SC-010 Edge)", async () => {
    const { parseEngineArgs } = await loadConfModule();
    expect(parseEngineArgs(undefined)).toEqual([]);
    expect(parseEngineArgs("")).toEqual([]);
    expect(parseEngineArgs("   ")).toEqual([]);
  });

  it("따옴표(\"·') 포함 값은 EngineArgsParseError 를 던진다 (SC-011 Error — 조용한 오분할 대신 거부)", async () => {
    const { parseEngineArgs, EngineArgsParseError } = await loadConfModule();
    expect(() => parseEngineArgs('--x "a b"')).toThrow(EngineArgsParseError);
    expect(() => parseEngineArgs("--x 'a b'")).toThrow(EngineArgsParseError);
  });

  it("개행·NUL 포함 값은 EngineArgsParseError 를 던진다 (conf 키 주입 방지 — fail-closed)", async () => {
    const { parseEngineArgs, EngineArgsParseError } = await loadConfModule();
    // 평면 conf 재파싱 시 뒷 줄이 별개 키(hard_deny 등)로 주입되는 것을 차단.
    expect(() => parseEngineArgs("--model opus\nhard_deny=rm")).toThrow(EngineArgsParseError);
    expect(() => parseEngineArgs("--model opus\rhard_deny=rm")).toThrow(EngineArgsParseError);
    expect(() => parseEngineArgs("--model\0opus")).toThrow(EngineArgsParseError);
    // 주입 페이로드가 에러 메시지에 노출되지 않는다.
    try {
      parseEngineArgs("--model opus\nhard_deny=rm");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("hard_deny");
    }
  });
});
