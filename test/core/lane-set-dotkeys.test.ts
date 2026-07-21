import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { laneAdd, laneSet, laneShow, laneKeyMeta, LaneConfigError } from "../../src/core/lane-config.js";
import { parseLaneConf } from "../../src/shared/conf.js";
import { collectSetInteractive } from "../../src/cli/lane.js";
import type { Ask } from "../../src/cli/lane.js";

/** 스크립트된 ask — 질문에 매칭 키가 있으면 그 값, 없으면 빈 입력(=현재값 유지). */
function scriptedAsk(answers: Record<string, string>): Ask {
  return async (q, def) => {
    for (const [k, v] of Object.entries(answers)) if (q.includes(k)) return v;
    return def ?? "";
  };
}

// 003-lane-settings-commands — 점표기 edits/unset·스키마 검증·show 메타(SC-1~SC-10 코어 매핑).

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-dotkeys-"));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

async function addMarkdown(lane: string): Promise<void> {
  await laneAdd("proj", lane, { base, source: "markdown", root: "/v", inbox: "inbox.md" });
}

describe("점표기 set + round-trip (SC-1)", () => {
  it("markdown.retention_days 7 이 conf 에 기록되고 재파싱이 일치한다", async () => {
    await addMarkdown("l1");
    const r = await laneSet("proj", "l1", {
      base,
      edits: [{ key: "markdown.retention_days", value: "7" }],
    });
    expect(r.conf.markdown?.retention_days).toBe(7);
    const reparsed = parseLaneConf(fs.readFileSync(r.confPath, "utf8"));
    expect(reparsed.markdown?.retention_days).toBe(7);
  });

  it("신규 markdown 그룹 키(archive·sync_provider)도 점표기로 기록된다", async () => {
    await addMarkdown("l1b");
    const r = await laneSet("proj", "l1b", {
      base,
      edits: [
        { key: "markdown.archive", value: "sent" },
        { key: "markdown.sync_provider", value: "icloud" },
      ],
    });
    expect(r.conf.markdown?.archive).toBe("sent");
    expect(r.conf.markdown?.sync_provider).toBe("icloud");
  });
});

describe("unset (SC-2 / SC-3)", () => {
  it("unset markdown.retention_days → conf 에서 제거(소비측 기본값 복원)", async () => {
    await addMarkdown("l2");
    await laneSet("proj", "l2", { base, edits: [{ key: "markdown.retention_days", value: "7" }] });
    const r = await laneSet("proj", "l2", { base, unset: ["markdown.retention_days"] });
    expect(r.conf.markdown?.retention_days).toBeUndefined();
    expect(fs.readFileSync(r.confPath, "utf8")).not.toContain("retention_days");
  });

  it("unset markdown.root → 필수 키라 거부(SC-3)", async () => {
    await addMarkdown("l3");
    await expect(laneSet("proj", "l3", { base, unset: ["markdown.root"] })).rejects.toThrow(
      LaneConfigError,
    );
  });
});

describe("정체성·미노출·미지 키 거부 (SC-4 / SC-5 / SC-9)", () => {
  it("점표기 source 편집은 identity 거부(SC-4)", async () => {
    await addMarkdown("l4");
    await expect(
      laneSet("proj", "l4", { base, edits: [{ key: "source", value: "telegram" }] }),
    ).rejects.toThrow(LaneConfigError);
  });

  it("오타 키(markdown.retention_day)는 거부되고 유사 키를 제안한다(SC-5)", async () => {
    await addMarkdown("l5");
    let caught: unknown;
    try {
      await laneSet("proj", "l5", { base, edits: [{ key: "markdown.retention_day", value: "7" }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LaneConfigError);
    expect((caught as Error).message).toContain("markdown.retention_days");
  });

  it.each(["auto_relaunch", "acp_version", "gate_timeout_sec"])(
    "내부 노브(%s) 점표기 편집은 거부된다(SC-9, 최소 표면)",
    async (key) => {
      await addMarkdown(`l9-${key}`);
      await expect(
        laneSet("proj", `l9-${key}`, { base, edits: [{ key, value: "x" }] }),
      ).rejects.toThrow(LaneConfigError);
    },
  );
});

describe("교차소스 거부 (SC-7)", () => {
  it("markdown 레인에 telegram.chat_id 점표기 편집은 거부된다", async () => {
    await addMarkdown("l7");
    await expect(
      laneSet("proj", "l7", { base, edits: [{ key: "telegram.chat_id", value: "123" }] }),
    ).rejects.toThrow(LaneConfigError);
  });
});

describe("배치 원자성 (SC-10)", () => {
  it("배치 중 하나라도 무효(enum bogus)면 전부 미기록", async () => {
    await addMarkdown("l10");
    const before = fs.readFileSync((await laneShow("proj", "l10", { base })).confPath, "utf8");
    await expect(
      laneSet("proj", "l10", {
        base,
        edits: [
          { key: "markdown.retention_days", value: "5" },
          { key: "markdown.sync_provider", value: "bogus" },
        ],
      }),
    ).rejects.toThrow(LaneConfigError);
    const after = fs.readFileSync((await laneShow("proj", "l10", { base })).confPath, "utf8");
    expect(after).toBe(before);
  });

  it("잘못된 정수 값은 set-시점에 거부된다", async () => {
    await addMarkdown("l10b");
    await expect(
      laneSet("proj", "l10b", { base, edits: [{ key: "markdown.retention_days", value: "abc" }] }),
    ).rejects.toThrow(LaneConfigError);
  });
});

describe("lane show 메타 (SC-8)", () => {
  it("명시 설정 키는 value/default/explicit/editable/identity 를 정확히 반환한다", async () => {
    await addMarkdown("l8");
    await laneSet("proj", "l8", { base, edits: [{ key: "markdown.retention_days", value: "7" }] });
    const { conf, text } = await laneShow("proj", "l8", { base });
    const meta = laneKeyMeta(conf, text, "markdown.retention_days");
    expect(meta).toEqual({
      key: "markdown.retention_days",
      value: 7,
      default: 2,
      explicit: true,
      editable: true,
      identity: false,
    });
  });

  it("unset 후에는 explicit=false·value=null·default 유지", async () => {
    await addMarkdown("l8b");
    await laneSet("proj", "l8b", { base, edits: [{ key: "markdown.retention_days", value: "7" }] });
    await laneSet("proj", "l8b", { base, unset: ["markdown.retention_days"] });
    const { conf, text } = await laneShow("proj", "l8b", { base });
    const meta = laneKeyMeta(conf, text, "markdown.retention_days");
    expect(meta?.explicit).toBe(false);
    expect(meta?.value).toBeNull();
    expect(meta?.default).toBe(2);
  });

  it("미지 키는 undefined 를 반환한다", async () => {
    await addMarkdown("l8c");
    const { conf, text } = await laneShow("proj", "l8c", { base });
    expect(laneKeyMeta(conf, text, "markdown.bogus")).toBeUndefined();
  });
});

describe("무인자 위저드 collectSetInteractive (SC-6 빈=현재값 유지)", () => {
  it("모든 입력이 빈 값이면 변경 없음(현재값 전부 유지)", async () => {
    await addMarkdown("w1");
    await laneSet("proj", "w1", { base, edits: [{ key: "markdown.retention_days", value: "5" }] });
    const { conf } = await laneShow("proj", "w1", { base });
    const allEmpty = scriptedAsk({});
    expect(await collectSetInteractive(allEmpty, conf, allEmpty)).toEqual([]);
  });

  it("현재값과 동일한 입력도 변경 없음(val === current 스킵)", async () => {
    await addMarkdown("w2");
    await laneSet("proj", "w2", { base, edits: [{ key: "markdown.retention_days", value: "5" }] });
    const { conf } = await laneShow("proj", "w2", { base });
    const sameVal = scriptedAsk({ "(5)": "5" });
    expect(await collectSetInteractive(sameVal, conf, sameVal)).toEqual([]);
  });

  it("값을 입력한 키만 변경으로 수집된다", async () => {
    await addMarkdown("w3");
    await laneSet("proj", "w3", { base, edits: [{ key: "markdown.retention_days", value: "5" }] });
    const { conf } = await laneShow("proj", "w3", { base });
    const changeOne = scriptedAsk({ "(5)": "9" });
    expect(await collectSetInteractive(changeOne, conf, changeOne)).toEqual([
      { key: "markdown.retention_days", value: "9" },
    ]);
  });
});
