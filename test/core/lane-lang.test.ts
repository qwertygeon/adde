import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { laneAdd } from "../../src/core/lane-config.js";
import { parseLaneConf, serializeLaneConf } from "../../src/shared/conf.js";
import { tFor, setLocale, resolveLocale } from "../../src/shared/i18n.js";
import { formatWarnNote } from "../../src/shared/notify.js";

// 레인별 채널 로케일(LaneConf.lang) — conf 저장·검증·tFor·notify 포매터 연동

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lang-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("laneAdd --lang", () => {
  it("lang 이 conf 에 기록되고 파싱 round-trip 된다", async () => {
    const res = await laneAdd("proj", "tg", { base, lang: "en" });
    expect(res.conf.lang).toBe("en");
    const parsed = parseLaneConf(fs.readFileSync(res.confPath, "utf8"));
    expect(parsed.lang).toBe("en");
    expect(parseLaneConf(serializeLaneConf(parsed)).lang).toBe("en");
  });

  it("미지원 lang 은 비차단 경고(생성은 진행·전역 로케일 적용 안내)", async () => {
    const res = await laneAdd("proj", "tg", { base, lang: "fr" });
    expect(fs.existsSync(res.confPath)).toBe(true);
    expect(res.warnings.some((w) => w.includes("lang") && w.includes("fr"))).toBe(true);
  });

  it("lang 미지정 시 conf 에 lang 키 없음(기본 동작 불변)", async () => {
    const res = await laneAdd("proj", "tg", { base });
    expect(res.conf.lang).toBeUndefined();
    expect(fs.readFileSync(res.confPath, "utf8")).not.toContain("lang=");
  });
});

describe("tFor — 레인 로케일 고정", () => {
  afterEach(() => setLocale(resolveLocale()));

  it("전역이 ko 여도 tFor('en') 은 영어를 반환한다", () => {
    setLocale("ko");
    const tl = tFor("en");
    // usage.up 본문(플래그 표기 등)은 CLI 표면 변경에 따라 달라질 수 있으므로 로케일 판별에
    // 필요한 접두(Usage:)·핵심 토큰(adde up <proj>)만으로 검증(전체 리터럴에 결합하지 않음).
    expect(tl("usage.up")).toMatch(/^Usage: adde up <proj>/);
  });

  it("미지원·미지정 lang 은 전역 로케일을 따른다", () => {
    setLocale("ko");
    expect(tFor("fr")("usage.up")).toMatch(/^사용법: adde up <proj>/);
    expect(tFor(undefined)("usage.up")).toMatch(/^사용법: adde up <proj>/);
  });

  it("notify 포매터가 tl 로 프리픽스까지 로케일을 전환한다", () => {
    setLocale("ko");
    const note = { situation: "s", action: "a" };
    expect(formatWarnNote(note)).toContain("[ADDE 경고]");
    expect(formatWarnNote(note, tFor("en"))).toContain("[ADDE warning]");
    expect(formatWarnNote(note, tFor("en"))).toContain("↳ action:");
  });
});
