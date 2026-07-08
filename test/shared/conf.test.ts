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
