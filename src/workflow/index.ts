/**
 * `beginWorkflowProcessing()` — placeholder 를 경유하는 워크플로 처리 시작 게이트.
 * 비활성이면 전제조건 체크를 호출하지 않고 즉시 반환한다. 활성이면 전제조건 체크 결과에 따라
 * 시작을 허용하거나, 실패 전제·요구 하한·검출 버전을 담은 사용자 대면 보고를 동반해 거부한다.
 * 본 차수는 기존 명령·데몬 경로에서 이 함수를 호출하지 않는다(호출자 배선은 후속 Phase).
 */
import type { ProjectConf } from "../shared/conf.js";
import { isWorkflowEnabled } from "./config.js";
import {
  checkStoragePreconditions,
  type StoragePreconditionDeps,
  type StoragePreconditionFailure,
} from "./storage-preconditions.js";
import { t } from "../shared/i18n.js";

export type WorkflowStartOutcome =
  | { readonly started: false; readonly kind: "disabled" }
  | {
      readonly started: false;
      readonly kind: "precondition_failed";
      readonly failure: StoragePreconditionFailure;
      /** 사용자 대면 보고 문구(i18n 경유 — 실패 전제·요구 하한·검출 버전 포함). */
      readonly report: string;
    }
  | { readonly started: true };

/** 값이 없을 때 카탈로그의 공통 대체 문구를 쓴다(하드코딩 영단어 리터럴 방지 — 두 언어 모두 지원). */
function displayOr(value: string | undefined): string {
  return value ?? t("workflow.precondition.unknownValue");
}

function buildFailureReport(failure: StoragePreconditionFailure): string {
  const requiredNodeFloor = displayOr(failure.requiredNodeFloor);
  const requiredSqlite = failure.requiredSqliteLibraryVersion;
  const detectedSqlite = displayOr(failure.detectedSqliteLibraryVersion);
  const nodeVersion = failure.nodeVersion;

  let reasonText: string;
  switch (failure.reason) {
    case "module_absent":
      reasonText = t("workflow.precondition.moduleAbsent", {
        requiredNodeFloor,
        requiredSqlite,
        nodeVersion,
      });
      break;
    case "module_behind_flag":
      reasonText = t("workflow.precondition.moduleBehindFlag", {
        requiredNodeFloor,
        requiredSqlite,
        nodeVersion,
      });
      break;
    case "library_version_below_floor":
      reasonText = t("workflow.precondition.libraryVersionBelowFloor", {
        requiredSqlite,
        detectedSqlite,
        nodeVersion,
      });
      break;
    case "indeterminate":
      reasonText = t("workflow.precondition.indeterminate", {
        requiredSqlite,
        detectedSqlite,
        nodeVersion,
      });
      break;
    default: {
      const exhaustive: never = failure.reason;
      reasonText = String(exhaustive);
    }
  }
  return `${t("workflow.precondition.refused")} ${reasonText}`;
}

export async function beginWorkflowProcessing(
  conf: Pick<ProjectConf, "workflow.enabled">,
  deps?: StoragePreconditionDeps,
): Promise<WorkflowStartOutcome> {
  if (!isWorkflowEnabled(conf)) {
    return { started: false, kind: "disabled" };
  }
  const result = await checkStoragePreconditions(deps);
  if (!result.ok) {
    return {
      started: false,
      kind: "precondition_failed",
      failure: result,
      report: buildFailureReport(result),
    };
  }
  return { started: true };
}
