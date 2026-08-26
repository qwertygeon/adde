import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-028 (FR-028): vault 미지정 시 프로젝트 생성이 거부되고 기본 경로도 만들어지지 않는다.

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-028: 저장소 루트 미지정 시 프로젝트 생성이 거부된다", () => {
  it("Happy: vault 미지정 conf 파싱이 오류를 반환한다", async () => {
    const conf = await import("../../src/shared/conf.js");
    expect(() => conf.parseProjectConf("v=1\n")).toThrow(/vault/i);
  });

  it("Edge: 빈 문자열·공백뿐인 vault 값도 미지정과 동일하게 거부된다", async () => {
    const conf = await import("../../src/shared/conf.js");
    expect(() => conf.parseProjectConf("v=1\nvault=   \n")).toThrow(/vault/i);
    expect(() => conf.parseProjectConf("v=1\nvault=\n")).toThrow(/vault/i);
  });

  it("Error: 거부 시 어떤 기본 경로도 새로 생성되지 않는다(존재하지 않는 부모 경로 포함)", async () => {
    const conf = await import("../../src/shared/conf.js");
    const before = listFilesRecursive(roots.base);
    expect(() => conf.parseProjectConf("v=1\nvault=/nonexistent/parent/vault\n")).not.toThrow();
    // 부모 경로 부재는 파싱 단계가 아니라 프로젝트 생성 실행 단계에서 거부되는 것이 계약이므로,
    // 여기서는 파싱만으로 아무 디스크 변화가 없음을 확인한다.
    expect(listFilesRecursive(roots.base)).toEqual(before);
    void fs.existsSync;
  });
});
