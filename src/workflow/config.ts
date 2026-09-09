/** 워크플로 처리 placeholder 해석 — 기본 비활성(옵트인). */
import type { ProjectConf } from "../shared/conf.js";

/** conf 에서 워크플로 활성 여부를 해석한다. 키 부재·false 는 비활성(기본 동작 불변). */
export function isWorkflowEnabled(conf: Pick<ProjectConf, "workflow.enabled">): boolean {
  return conf["workflow.enabled"] === true;
}
