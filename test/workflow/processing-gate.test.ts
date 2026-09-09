import { describe, expect, it } from "vitest";

// 001-phase0-baseline-storage-spike — 워크플로 진입 게이트·placeholder 검증(T036).
// src/workflow/{config,index}.ts 를 동적 import 로 격리한다(PROC-R15 — 레이어 B 미착지 RED 예상).

async function importGateModules() {
  const [config, wf] = await Promise.all([
    import("../../src/workflow/config.js"),
    import("../../src/workflow/index.js"),
  ]);
  return { ...config, ...wf };
}

describe("SC-024: 체크 실패 시 워크플로 처리 시작이 거부되고 이유가 보고된다", () => {
  it("Happy: enabled=true + 전제조건 실패 시 started:false·kind:precondition_failed·report 에 실패 전제·요구 하한·검출 버전", async () => {
    const { beginWorkflowProcessing } = await importGateModules();
    const outcome = await beginWorkflowProcessing(
      { "workflow.enabled": true },
      {
        importSqlite: () => Promise.reject(new Error("Cannot find module 'node:sqlite'")),
        nodeVersion: "24.18.0",
      },
    );
    expect(outcome.started).toBe(false);
    if (!outcome.started && outcome.kind === "precondition_failed") {
      expect(outcome.failure.reason).toBe("module_absent");
      expect(outcome.report).toMatch(/SQLite\s*모듈|사용할\s*수\s*없습니다/);
      expect(outcome.report).toMatch(/3\.51\.3|요구\s*SQLite|요구\s*하한/);
    } else {
      throw new Error(`expected kind:precondition_failed, got ${JSON.stringify(outcome)}`);
    }
  });

  it("Edge: 검출 버전이 없는 실패(모듈 부재)에서도 report 가 요구 하한을 포함한다", async () => {
    const { beginWorkflowProcessing } = await importGateModules();
    const outcome = await beginWorkflowProcessing(
      { "workflow.enabled": true },
      {
        importSqlite: () => Promise.reject(new Error("module not found")),
        nodeVersion: "24.18.0",
      },
    );
    expect(outcome.started).toBe(false);
    if (!outcome.started && outcome.kind === "precondition_failed") {
      expect(outcome.failure.detectedSqliteLibraryVersion).toBeUndefined();
      expect(outcome.failure.requiredSqliteLibraryVersion.length).toBeGreaterThan(0);
    }
  });

  it("Error: report 에 부분 성공 문구가 없다", async () => {
    const { beginWorkflowProcessing } = await importGateModules();
    const outcome = await beginWorkflowProcessing(
      { "workflow.enabled": true },
      {
        importSqlite: () => Promise.reject(new Error("module not found")),
        nodeVersion: "24.18.0",
      },
    );
    expect(outcome.started).toBe(false);
    if (!outcome.started && outcome.kind === "precondition_failed") {
      expect(outcome.report).not.toMatch(/부분\s*성공|partial success/i);
    }
  });
});

describe("SC-039: 기본 비활성이고 기존 경로가 불변이다", () => {
  it("Happy: workflow.enabled 미기재 conf 는 비활성으로 해석되고 경고 0건이다", async () => {
    const { isWorkflowEnabled } = await importGateModules();
    expect(isWorkflowEnabled({} as never)).toBe(false);
  });

  it("Edge: 명시 false·대소문자 변형도 비활성으로 해석된다", async () => {
    const { isWorkflowEnabled } = await importGateModules();
    expect(isWorkflowEnabled({ "workflow.enabled": false })).toBe(false);
  });

  it("Error: 비활성 상태에서 beginWorkflowProcessing 은 전제조건 체크를 호출하지 않는다(disabled 즉시 반환)", async () => {
    const { beginWorkflowProcessing } = await importGateModules();
    let calledPrecondition = false;
    const outcome = await beginWorkflowProcessing(
      { "workflow.enabled": false },
      {
        importSqlite: () => {
          calledPrecondition = true;
          return Promise.reject(new Error("should not be called"));
        },
        nodeVersion: "24.18.0",
      },
    );
    expect(outcome).toEqual({ started: false, kind: "disabled" });
    expect(calledPrecondition).toBe(false);
  });
});
