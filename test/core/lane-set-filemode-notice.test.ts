import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { laneAdd, resolveFileMode } from "../../src/core/lane-config.js";
import { secureLaneDirs } from "../../src/shared/fs-atomic.js";
import { lanePaths } from "../../src/shared/paths.js";
import { t } from "../../src/shared/i18n.js";

// 020-lane-set-filemode-notice — private→shared 편집 인지 경고(SC-1)·오탐 방지(SC-2)·
// 실 디렉터리 권한 fail-closed 유지 시맨틱 고정(SC-3).

const NOTICE = t("laneConfig.warn.fileModeRelaxNotice");

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-lane-fm-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

async function loadCore() {
  return import("../../src/core/lane-config.js");
}

describe("file_mode private→shared 편집 인지 경고 (SC-1)", () => {
  it("private(명시) 레인을 shared 로 편집하면 완화 안내 경고가 정확히 1건 추가된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane1", { base, source: "markdown", file_mode: "private" });
    const result = await laneSet("proj", "lane1", { base, file_mode: "shared" });
    expect(result.warnings.filter((w) => w === NOTICE)).toHaveLength(1);
  });

  it("file_mode 미지정(=private) 레인을 shared 로 편집해도 완화 안내가 추가된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane2", { base, source: "markdown" }); // file_mode 미설정 = private
    const result = await laneSet("proj", "lane2", { base, file_mode: "shared" });
    expect(result.warnings).toContain(NOTICE);
  });
});

describe("완화 안내 오탐 방지 (SC-2)", () => {
  it("shared→shared 재편집은 안내를 추가하지 않는다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane3", { base, source: "markdown", file_mode: "shared" });
    const result = await laneSet("proj", "lane3", { base, file_mode: "shared" });
    expect(result.warnings).not.toContain(NOTICE);
  });

  it("shared→private 편집(조이는 방향)은 안내를 추가하지 않는다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane4", { base, source: "markdown", file_mode: "shared" });
    const result = await laneSet("proj", "lane4", { base, file_mode: "private" });
    expect(result.warnings).not.toContain(NOTICE);
  });

  it("file_mode 미편집(다른 필드만) 은 안내를 추가하지 않는다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane5", { base, source: "markdown", file_mode: "private" });
    const result = await laneSet("proj", "lane5", { base, cwd: "/tmp/x" });
    expect(result.warnings).not.toContain(NOTICE);
  });
});

describe("실 디렉터리 권한 fail-closed 유지 — 기동 경로 관통 (SC-3)", () => {
  it("private 디렉터리를 shared 로 편집 후 기동 권한 적용을 재실행해도 0700 이 유지된다", async () => {
    const { laneSet } = await loadCore();
    await laneAdd("proj", "lane6", { base, source: "markdown", file_mode: "private" });
    const paths = lanePaths(base, "proj", "lane6");
    // 기동 경로가 private 로 잠근 상태를 재현.
    await secureLaneDirs([paths.stateDir], "private");
    expect(fs.statSync(paths.stateDir).mode & 0o777).toBe(0o700);

    // shared 로 편집(conf 값만 갱신) + 기동 경로가 호출하는 형태로 권한 재적용.
    const result = await laneSet("proj", "lane6", { base, file_mode: "shared" });
    await secureLaneDirs([paths.stateDir], resolveFileMode(result.conf.file_mode));

    // shared 는 no-op — 기존 0700 이 완화되지 않고 그대로 유지(fail-closed).
    expect(fs.statSync(paths.stateDir).mode & 0o777).toBe(0o700);
  });
});
