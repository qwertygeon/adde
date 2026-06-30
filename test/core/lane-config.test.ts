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
    await expect(
      laneAdd("proj", "tg", { base, allowlist: ["Read", "rm -rf /"] }),
    ).rejects.toThrow(LaneConfigError);
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
    await expect(laneAdd("proj", "tg", { base, chat_id: "abc" })).rejects.toThrow(
      LaneConfigError,
    );
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
    await expect(
      laneAdd("proj", "md", { base, source: "markdown", token: "x" }),
    ).rejects.toThrow(LaneConfigError);
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
