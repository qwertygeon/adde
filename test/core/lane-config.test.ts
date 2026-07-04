import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  laneAdd,
  laneList,
  laneShow,
  laneRemove,
  LaneConfigError,
} from "../../src/core/lane-config.js";
import { parseLaneConf } from "../../src/shared/conf.js";

// adde lane <add|ls|show|rm> 코어 — conf 생성/조회/삭제, 검증, 원자적 쓰기

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lane-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("laneAdd 사전 검증 경고 (007 SC4)", () => {
  it("존재하는 cwd 는 경고 없음", async () => {
    const res = await laneAdd("proj", "tg", { base, cwd: base });
    expect(res.warnings.some((w) => w.includes("cwd"))).toBe(false);
  });

  it("없는 cwd 는 비차단 경고(생성은 진행)", async () => {
    const res = await laneAdd("proj", "tg", { base, cwd: path.join(base, "nope") });
    expect(fs.existsSync(res.confPath)).toBe(true);
    expect(res.warnings.some((w) => w.includes("cwd") && w.includes("조치"))).toBe(true);
  });

  it("markdown 인데 root 없으면 경고", async () => {
    const res = await laneAdd("proj", "md", { base, source: "markdown" });
    expect(res.warnings.some((w) => w.includes("root"))).toBe(true);
  });

  it("allowlist 도구명 문자셋 위반은 거부한다 (011-C)", async () => {
    await expect(laneAdd("proj", "tg", { base, allowlist: ["Read", "rm -rf /"] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("telegram 토큰 형식이 이상하면 경고, 정상이면 없음", async () => {
    const bad = await laneAdd("proj", "tg1", { base, token: "not-a-token" });
    expect(bad.warnings.some((w) => w.includes("토큰 형식"))).toBe(true);
    const ok = await laneAdd("proj", "tg2", {
      base,
      token: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345678",
    });
    expect(ok.warnings.some((w) => w.includes("토큰 형식"))).toBe(false);
  });
});

describe("laneAdd", () => {
  it("기본값으로 telegram 레인 conf 를 생성한다", async () => {
    const res = await laneAdd("proj", "tg", { base });
    expect(fs.existsSync(res.confPath)).toBe(true);
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.source).toBe("telegram");
    expect(conf.backend).toBe("acp");
    expect(conf.engine).toBe("claude-code-acp");
    expect(conf.channel).toBe("telegram");
    expect(conf.perm_tier).toBe("acp");
    expect(conf.acp_version).toBe("v1");
  });

  it("옵션을 conf 에 반영한다(cwd/allowlist/chat_id)", async () => {
    const res = await laneAdd("proj", "tg", {
      base,
      cwd: "/abs/project",
      allowlist: ["Read", "Grep"],
      chat_id: "12345",
    });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.cwd).toBe("/abs/project");
    expect(conf.allowlist).toEqual(["Read", "Grep"]);
    expect(conf.chat_id).toBe("12345");
  });

  it("--safe-defaults 는 hard_deny 에 내장 위험 목록을 채운다", async () => {
    const res = await laneAdd("proj", "tg", { base, safe_defaults: true });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.hard_deny).toContain("Bash(sudo *)");
    expect(conf.hard_deny).toContain("Read(~/.ssh/**)");
  });

  it("--safe-defaults 는 explicit hard_deny 와 합집합(중복 제거)", async () => {
    const res = await laneAdd("proj", "tg", {
      base,
      safe_defaults: true,
      hard_deny: ["Write(/etc/*)", "Bash(sudo *)"],
    });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.hard_deny).toContain("Write(/etc/*)");
    expect(conf.hard_deny.filter((e) => e === "Bash(sudo *)").length).toBe(1);
  });

  it("hard_deny 미지정이면 빈 목록(기본 동작 불변)", async () => {
    const res = await laneAdd("proj", "tg", { base });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.hard_deny).toEqual([]);
  });

  it("잘못된 hard_deny 항목은 거부한다", async () => {
    await expect(laneAdd("proj", "tg", { base, hard_deny: ["Bash(("] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("source=markdown 과 markdown 키를 반영한다", async () => {
    const res = await laneAdd("proj", "md", {
      base,
      source: "markdown",
      root: "/abs/Notes",
      inbox: "in.md",
    });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.source).toBe("markdown");
    expect(conf.channel).toBe("markdown");
    expect(conf.root).toBe("/abs/Notes");
    expect(conf.inbox).toBe("in.md");
  });

  it("미지원 source 는 거부한다", async () => {
    await expect(laneAdd("proj", "x", { base, source: "discord" })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("잘못된 lane 이름은 거부한다", async () => {
    await expect(laneAdd("proj", "bad/name", { base })).rejects.toThrow(LaneConfigError);
    await expect(laneAdd("proj", "..", { base })).rejects.toThrow(LaneConfigError);
  });

  it("숫자가 아닌 chat_id 는 거부한다", async () => {
    await expect(laneAdd("proj", "tg", { base, chat_id: "abc" })).rejects.toThrow(LaneConfigError);
  });

  it("음수 chat_id(그룹)는 허용한다", async () => {
    const res = await laneAdd("proj", "tg", { base, chat_id: "-100123" });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.chat_id).toBe("-100123");
  });

  it("기존 conf 는 force 없이는 덮어쓰지 않는다", async () => {
    await laneAdd("proj", "tg", { base });
    await expect(laneAdd("proj", "tg", { base })).rejects.toThrow(LaneConfigError);
  });

  it("force 면 기존 conf 를 덮어쓴다", async () => {
    await laneAdd("proj", "tg", { base });
    const res = await laneAdd("proj", "tg", { base, force: true, cwd: "/new" });
    const conf = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(conf.cwd).toBe("/new");
  });

  it("token 을 .env(0600) 에 기록한다", async () => {
    const res = await laneAdd("proj", "tg", { base, token: "111:ABC" });
    expect(res.envPath).toBeDefined();
    expect(fs.readFileSync(res.envPath!, "utf8")).toContain("TELEGRAM_BOT_TOKEN=111:ABC");
    const mode = fs.statSync(res.envPath!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("markdown 레인에 token 을 주면 거부한다", async () => {
    await expect(laneAdd("proj", "md", { base, source: "markdown", token: "x" })).rejects.toThrow(
      LaneConfigError,
    );
  });
});

describe("laneList", () => {
  it("레인이 없으면 빈 배열", async () => {
    expect((await laneList("proj", { base })).lanes).toEqual([]);
  });

  it("생성된 레인을 정렬해 나열한다", async () => {
    await laneAdd("proj", "b-lane", { base });
    await laneAdd("proj", "a-lane", { base });
    expect((await laneList("proj", { base })).lanes).toEqual(["a-lane", "b-lane"]);
  });
});

describe("laneShow", () => {
  it("conf 텍스트와 파싱 결과를 반환한다", async () => {
    await laneAdd("proj", "tg", { base, cwd: "/p" });
    const res = await laneShow("proj", "tg", { base });
    expect(res.conf.cwd).toBe("/p");
    expect(res.text).toContain("cwd=/p");
  });

  it("없는 레인은 에러", async () => {
    await expect(laneShow("proj", "nope", { base })).rejects.toThrow(LaneConfigError);
  });
});

describe("laneRemove", () => {
  it("conf 를 삭제한다", async () => {
    const add = await laneAdd("proj", "tg", { base });
    await laneRemove("proj", "tg", { base });
    expect(fs.existsSync(add.confPath)).toBe(false);
  });

  it("없는 레인 삭제는 에러", async () => {
    await expect(laneRemove("proj", "nope", { base })).rejects.toThrow(LaneConfigError);
  });
});

describe("laneAdd — denylist·perm_tier 검증 (005 autopass)", () => {
  it("denylist 를 conf 에 기록하고 round-trip 파싱된다", async () => {
    const res = await laneAdd("proj", "ap", {
      base,
      perm_tier: "autopass",
      denylist: ["Bash", "Write"],
    });
    const parsed = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(parsed.perm_tier).toBe("autopass");
    expect(parsed.denylist).toEqual(["Bash", "Write"]);
  });

  it("denylist 도구명 문자셋 위반은 거부한다", async () => {
    await expect(laneAdd("proj", "ap2", { base, denylist: ["Bash", "rm -rf /"] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("perm_tier=autopass 는 자동 허용 위험 경고를 낸다(비차단)", async () => {
    const res = await laneAdd("proj", "ap3", {
      base,
      perm_tier: "autopass",
      denylist: ["Bash"],
    });
    expect(fs.existsSync(res.confPath)).toBe(true);
    expect(res.warnings.some((w) => w.includes("autopass") && w.includes("자동 허용"))).toBe(true);
  });

  it("autopass 인데 denylist 를 명시적으로 비우면 추가 경고를 낸다 (미지정은 006 기본값 적용)", async () => {
    const res = await laneAdd("proj", "ap4", { base, perm_tier: "autopass", denylist: [] });
    expect(res.warnings.some((w) => w.includes("denylist 가 비어"))).toBe(true);
  });

  it("알 수 없는 perm_tier 값은 오타 경고를 낸다(비차단, acp 처럼 동작)", async () => {
    const res = await laneAdd("proj", "typo", { base, perm_tier: "autopas" });
    expect(fs.existsSync(res.confPath)).toBe(true);
    expect(res.warnings.some((w) => w.includes("perm_tier") && w.includes("알려진 값"))).toBe(true);
  });

  it("기본(perm_tier=acp) 레인에는 perm_tier 경고가 없다 (기본 동작 불변)", async () => {
    const res = await laneAdd("proj", "plain", { base });
    expect(res.warnings.some((w) => w.includes("perm_tier"))).toBe(false);
  });
});

describe("laneAdd — allowlist∩denylist 교집합 경고 (005 DEC-006)", () => {
  it("autopass 에서 양쪽에 같은 도구가 있으면 denylist 우선 경고를 낸다", async () => {
    const res = await laneAdd("proj", "ap5", {
      base,
      perm_tier: "autopass",
      allowlist: ["Bash", "Read"],
      denylist: ["Bash"],
    });
    expect(res.warnings.some((w) => w.includes("denylist 가 우선"))).toBe(true);
  });

  it("교집합이 없으면 해당 경고가 없다", async () => {
    const res = await laneAdd("proj", "ap6", {
      base,
      perm_tier: "autopass",
      allowlist: ["Read"],
      denylist: ["Bash"],
    });
    expect(res.warnings.some((w) => w.includes("denylist 가 우선"))).toBe(false);
  });
});

describe("laneAdd — denylist 패턴·기본값 (006)", () => {
  it("autopass + denylist 미지정 → 내장 기본 denylist 를 conf 에 명시 기록", async () => {
    const res = await laneAdd("proj", "apdef", { base, perm_tier: "autopass" });
    const parsed = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(parsed.denylist.length).toBeGreaterThan(0);
    expect(parsed.denylist).toContain("Bash(sudo *)");
    expect(parsed.denylist).toContain("Read(~/.ssh/**)");
  });

  it("명시 --denylist 는 기본값을 대체하고, acp 티어는 기본 denylist 를 받지 않는다", async () => {
    const explicit = await laneAdd("proj", "apexp", {
      base,
      perm_tier: "autopass",
      denylist: ["Bash(git push*)"],
    });
    expect(explicit.conf.denylist).toEqual(["Bash(git push*)"]);
    const acp = await laneAdd("proj", "plain2", { base });
    expect(acp.conf.denylist).toEqual([]);
  });

  it("Tool(glob) 패턴을 허용하고 형식 위반은 거부한다", async () => {
    const ok = await laneAdd("proj", "appat", {
      base,
      perm_tier: "autopass",
      denylist: ["Bash", "Write(/etc/*)", "Read(~/.ssh/**)"],
    });
    expect(ok.conf.denylist).toHaveLength(3);
    await expect(laneAdd("proj", "apbad", { base, denylist: ["Bash("] })).rejects.toThrow(
      LaneConfigError,
    );
  });

  it("markdown 경로 겹침(approvals=outbox)이면 생성 경고를 낸다 (기동은 거부됨 안내)", async () => {
    const res = await laneAdd("proj", "mdolap", {
      base,
      source: "markdown",
      root: base,
      inbox: "in.md",
      approvals: "shared/",
      outbox: "shared/",
    });
    expect(res.warnings.some((w) => w.includes("경로가 겹칩니다"))).toBe(true);
  });

  it("markdown 기본 경로 배치(approvals·out 형제)는 겹침 경고가 없다", async () => {
    const res = await laneAdd("proj", "mdok", {
      base,
      source: "markdown",
      root: base,
      inbox: "in.md",
    });
    expect(res.warnings.some((w) => w.includes("경로가 겹칩니다"))).toBe(false);
  });
});

describe("인바운드 인증(allow_from) + 파일 권한(file_mode)", () => {
  it("allow_from 를 conf 에 기록하고 round-trip 한다", async () => {
    const res = await laneAdd("proj", "af", { base, chat_id: "111", allow_from: "222,333" });
    expect(res.conf.allow_from).toBe("222,333");
    const reparsed = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(reparsed.allow_from).toBe("222,333");
  });

  it("allow_from 항목이 숫자가 아니면 거부한다", async () => {
    await expect(
      laneAdd("proj", "afbad", { base, chat_id: "1", allow_from: "222,abc" }),
    ).rejects.toThrow(LaneConfigError);
  });

  it("allow_from 는 telegram 전용 — markdown 이면 거부한다", async () => {
    await expect(
      laneAdd("proj", "afmd", { base, source: "markdown", root: base, allow_from: "222" }),
    ).rejects.toThrow(LaneConfigError);
  });

  it("chat_id·allow_from 둘 다 없는 telegram 레인은 fail-closed 경고를 낸다", async () => {
    const res = await laneAdd("proj", "noauth", { base });
    expect(res.warnings.some((w) => w.includes("fail-closed"))).toBe(true);
  });

  it("개인 chat_id(양수)가 있으면 인증 경고가 없다 (자기 chat 자동 인증)", async () => {
    const res = await laneAdd("proj", "hasauth", { base, chat_id: "555" });
    expect(res.warnings.some((w) => w.includes("fail-closed"))).toBe(false);
  });

  it("그룹 chat_id(음수)만 있고 allow_from 없으면 여전히 인증 경고 (멤버 미인증)", async () => {
    const res = await laneAdd("proj", "grpnoauth", { base, chat_id: "-1001234567890" });
    expect(res.warnings.some((w) => w.includes("fail-closed"))).toBe(true);
  });

  it("그룹 chat_id + allow_from 이면 경고 없음 (멤버 명시 인증)", async () => {
    const res = await laneAdd("proj", "grpauth", {
      base,
      chat_id: "-1001234567890",
      allow_from: "111,222",
    });
    expect(res.warnings.some((w) => w.includes("fail-closed"))).toBe(false);
  });

  it("file_mode 를 conf 에 기록한다 (shared 명시)", async () => {
    const res = await laneAdd("proj", "fm", { base, chat_id: "1", file_mode: "shared" });
    expect(res.conf.file_mode).toBe("shared");
  });

  it("file_mode 미지정 시 conf 에 쓰지 않는다 (기본 private 은 부재로 표현)", async () => {
    const res = await laneAdd("proj", "fmdef", { base, chat_id: "1" });
    expect(res.conf.file_mode).toBeUndefined();
  });

  it("file_mode 가 허용값(private|shared) 밖이면 거부한다", async () => {
    await expect(
      laneAdd("proj", "fmbad", { base, chat_id: "1", file_mode: "world" }),
    ).rejects.toThrow(LaneConfigError);
  });

  it("private(기본)로 토큰 기록 시 state 디렉터리를 0700 으로 잠근다", async () => {
    const res = await laneAdd("proj", "tokpriv", { base, chat_id: "1", token: "1:abc" });
    const stateDir = path.dirname(res.envPath as string);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("shared 로 토큰 기록 시 state 디렉터리 권한을 조이지 않는다", async () => {
    const res = await laneAdd("proj", "tokshared", {
      base,
      chat_id: "1",
      file_mode: "shared",
      token: "1:abc",
    });
    const stateDir = path.dirname(res.envPath as string);
    // shared 는 no-op — 0700 이 아니어야 한다(기본 umask 권한 유지).
    expect(fs.statSync(stateDir).mode & 0o777).not.toBe(0o700);
  });
});
