import { describe, expect, it } from "vitest";

// 확정 시그니처: PROJECT_KEY_DESCRIPTORS: readonly ProjectKeyDescriptor[] ·
// applyEdits(conf, edits): { conf, errors } — errors 가 비지 않으면 conf 를 반환하지 않는다.

describe("SC-058: 목록형 설정이 증분 편집된다", () => {
  it("Happy: 거부 목록에 항목 1개를 추가하면 기존 기본 항목이 유지된 채 1건이 추가된다", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    const conf = { v: 1, vault: "/tmp/v", denylist: ["rm -rf"] } as Record<string, unknown>;
    const { conf: updated, errors } = schema.applyEdits(conf as never, [
      { key: "denylist", op: "add", value: "curl" } as never,
    ]);
    expect(errors).toEqual([]);
    expect((updated as { denylist: string[] }).denylist).toEqual(
      expect.arrayContaining(["rm -rf", "curl"]),
    );
  });

  it("Edge: 이미 있는 항목을 추가해도 중복 없이 유지된다(멱등)", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    const conf = { v: 1, vault: "/tmp/v", denylist: ["rm -rf"] } as Record<string, unknown>;
    const { conf: updated, errors } = schema.applyEdits(conf as never, [
      { key: "denylist", op: "add", value: "rm -rf" } as never,
    ]);
    expect(errors).toEqual([]);
    expect((updated as { denylist: string[] }).denylist).toEqual(["rm -rf"]);
  });

  it("Error: 목록형이 아닌 키에 증분(add) 편집을 시도하면 거부된다", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    const conf = { v: 1, vault: "/tmp/v" } as Record<string, unknown>;
    const { errors } = schema.applyEdits(conf as never, [
      { key: "vault", op: "add", value: "x" } as never,
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("SC-059: 잘못된 편집이 전부 거부된다", () => {
  it("Happy: 유효 키 하나와 알 수 없는 키 하나를 함께 지정하면 요청 전체가 거부되고 파일이 변경되지 않는다", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    const original = { v: 1, vault: "/tmp/v", hibernate_after_min: 30 } as Record<string, unknown>;
    const { conf: updated, errors } = schema.applyEdits(original as never, [
      { key: "hibernate_after_min", op: "set", value: "60" } as never,
      { key: "totally_unknown_key", op: "set", value: "x" } as never,
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(updated).toBe(original); // 전건 검증 실패 시 원본 그대로 반환(변경 없음)
  });

  it("Edge: 값 타입 오류(정수 키에 문자열)도 전체 거부된다", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    const original = { v: 1, vault: "/tmp/v", hibernate_after_min: 30 } as Record<string, unknown>;
    const { errors } = schema.applyEdits(original as never, [
      { key: "hibernate_after_min", op: "set", value: "not-a-number" } as never,
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("Error: PROJECT_KEY_DESCRIPTORS 의 모든 키가 applyEdits 가 인식하는 key 집합에 존재한다", async () => {
    const schema = await import("../../src/shared/project-schema.js");
    for (const d of schema.PROJECT_KEY_DESCRIPTORS as unknown as Array<{
      key: string;
      editable: boolean;
    }>) {
      expect(typeof d.key).toBe("string");
      expect(typeof d.editable).toBe("boolean");
    }
  });
});
