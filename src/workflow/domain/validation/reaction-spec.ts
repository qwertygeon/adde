/**
 * Task 가 선언하는 전이 반응 — 형태와 구조 검사. 반응은 Task 전이 표의 행·동반 이벤트에 걸리고, 논리
 * 식별자는 Task 안에서 유일하다(idempotency key 입력이므로). 실행 효과 반응은 TaskType 이 정하므로
 * Task 가 선언하지 않는다.
 */
import { TASK_TRANSITION_ROWS } from "../contract/index.js";
import type { ReactionDescriptor } from "../registry/descriptors.js";

export interface ReactionSpec {
  readonly kind: string;
  readonly version: number;
  /** `^[a-z][a-z0-9_]{0,63}$`, Task 안 유일 */
  readonly reactionLogicalId: string;
  /** 이 Task 의 전이 표 행·동반 이벤트 이름, 1개 이상 */
  readonly on: readonly string[];
  /** descriptor.paramsSchema 로 검증 */
  readonly params: unknown;
}

export const REACTION_LOGICAL_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

const TASK_TRANSITION_EVENT_NAMES: ReadonlySet<string> = new Set(
  TASK_TRANSITION_ROWS.flatMap((row) => [row.event, ...row.companions]),
);

export type ReactionSpecIssueCode =
  | "reaction_params_invalid"
  | "reaction_logical_id_invalid"
  | "reaction_logical_id_duplicate"
  | "reaction_on_invalid"
  | "reaction_not_transition";

export interface ReactionSpecIssue {
  readonly code: ReactionSpecIssueCode;
  readonly path: readonly (string | number)[];
  readonly detail?: string;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * 식별 형태(`kind`·`version`)와 descriptor 조회가 끝난 선언 목록을 받는다. 반응마다 params → 논리
 * 식별 → `on` → 선언 위치 순으로 issue 를 모으고, 선언 순서로 정규화한 목록을 함께 돌려준다.
 */
export function checkReactionSpecs(
  declared: readonly unknown[],
  descriptors: readonly ReactionDescriptor[],
): { readonly issues: readonly ReactionSpecIssue[]; readonly specs: readonly ReactionSpec[] } {
  const issues: ReactionSpecIssue[] = [];
  const specs: ReactionSpec[] = [];
  const seenLogicalIds = new Set<string>();
  declared.forEach((raw, index) => {
    const descriptor = descriptors[index];
    if (!isPlainObject(raw) || descriptor === undefined) return;
    const base = ["reactions", index] as const;

    const params = descriptor.paramsSchema.safeParse(raw["params"]);
    if (!params.success) {
      for (const issue of params.error.issues) {
        issues.push({
          code: "reaction_params_invalid",
          path: [...base, "params", ...issue.path.map(pathSegment)],
          detail: issue.code,
        });
      }
    }

    const logicalId = raw["reactionLogicalId"];
    if (typeof logicalId !== "string" || !REACTION_LOGICAL_ID_RE.test(logicalId)) {
      issues.push({ code: "reaction_logical_id_invalid", path: [...base, "reactionLogicalId"] });
    } else if (seenLogicalIds.has(logicalId)) {
      issues.push({ code: "reaction_logical_id_duplicate", path: [...base, "reactionLogicalId"] });
    } else {
      seenLogicalIds.add(logicalId);
    }

    const on = raw["on"];
    if (!Array.isArray(on) || on.length === 0) {
      issues.push({ code: "reaction_on_invalid", path: [...base, "on"] });
    } else {
      on.forEach((name: unknown, onIndex) => {
        if (typeof name !== "string" || !TASK_TRANSITION_EVENT_NAMES.has(name)) {
          issues.push({
            code: "reaction_on_invalid",
            path: [...base, "on", onIndex],
            ...(typeof name === "string" ? { detail: name } : {}),
          });
        }
      });
    }

    if (descriptor.declaredAs !== "transition_reaction") {
      issues.push({ code: "reaction_not_transition", path: [...base] });
    }

    specs.push({
      kind: raw["kind"] as string,
      version: raw["version"] as number,
      reactionLogicalId: typeof logicalId === "string" ? logicalId : "",
      on: Array.isArray(on) ? (on.filter((n) => typeof n === "string") as string[]) : [],
      params: raw["params"],
    });
  });
  return { issues, specs };
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}
