/**
 * 관계 간선 그래프·순환 검출·계획 초안 검증·인과 체인(FR-013, FR-014) — design.md `plan-graph.ts` 그대로.
 * 의존 간선만 활성화 게이트·의존 충족·순환 검출에 참여하고, 부모·인과 간선은 참여하지 않는다.
 */
import type { TaskId } from "./ids.js";
import type {
  TaskRef,
  PlanTaskDraft,
  DescriptorUnknownBlockReason,
  ApprovalSurfaceRefusedBlockReason,
} from "./commands.js";
import type { WorkflowEventEnvelope } from "./events.js";
import type { ValidationIssue } from "./validation/task-validation.js";

export type RelationEdgeKind = "dependency" | "parent" | "causal";

/** from 이 to 에 의존 / from 의 부모가 to / from 이 to 에 의해 유발. */
export interface RelationEdge {
  readonly kind: RelationEdgeKind;
  readonly from: string;
  readonly to: string;
}

export interface RelationGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly RelationEdge[];
}

export type DraftInvalidReason =
  | DescriptorUnknownBlockReason
  | ApprovalSurfaceRefusedBlockReason
  | { readonly kind: "structurally_invalid"; readonly issues: readonly ValidationIssue[] };

export type PlanValidationIssue =
  | { readonly kind: "duplicate_draft_ref"; readonly draftRef: string }
  | { readonly kind: "unknown_dependency"; readonly draftRef: string; readonly ref: TaskRef }
  | { readonly kind: "unknown_parent"; readonly draftRef: string; readonly ref: TaskRef }
  | { readonly kind: "self_parent"; readonly draftRef: string }
  /** 초안 순서 정렬 */
  | { readonly kind: "parent_cycle"; readonly draftRefs: readonly string[] }
  | { readonly kind: "dependency_cycle"; readonly draftRefs: readonly string[] }
  | {
      readonly kind: "trigger_requires_dependencies";
      readonly draftRef: string;
      readonly trigger: { readonly kind: string; readonly version: number };
    }
  | {
      readonly kind: "draft_invalid";
      readonly draftRef: string;
      readonly reason: DraftInvalidReason;
    };

function refKey(ref: TaskRef): string {
  return "draftRef" in ref ? ref.draftRef : ref.taskId;
}

export function planRelationGraph(drafts: readonly PlanTaskDraft[]): RelationGraph {
  const nodes = drafts.map((d) => d.draftRef);
  const edges: RelationEdge[] = [];
  for (const draft of drafts) {
    for (const dep of draft.dependsOn) {
      edges.push({ kind: "dependency", from: draft.draftRef, to: refKey(dep) });
    }
    if (draft.parent !== undefined) {
      edges.push({ kind: "parent", from: draft.draftRef, to: refKey(draft.parent) });
    }
  }
  return { nodes, edges };
}

/** dependency 간선만의 강연결요소 중 크기 ≥ 2 또는 자기 간선. 각 순환은 nodes 순서로 정렬, 순환 목록은
 * 첫 원소의 nodes 위치 순(Tarjan SCC, 결정적 순서). */
export function findDependencyCycles(graph: RelationGraph): readonly (readonly string[])[] {
  return findCycles(graph, "dependency", true);
}

/** 초안 → 초안 부모 간선의 순환(크기 ≥ 2). 자기 부모는 별도 이슈라 여기 넣지 않는다. */
function findParentCycles(graph: RelationGraph): readonly (readonly string[])[] {
  return findCycles(graph, "parent", false);
}

function findCycles(
  graph: RelationGraph,
  kind: RelationEdgeKind,
  includeSelfEdges: boolean,
): readonly (readonly string[])[] {
  const kindEdges = graph.edges.filter((e) => e.kind === kind);
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) adjacency.set(node, []);
  for (const edge of kindEdges) {
    const list = adjacency.get(edge.from);
    if (list !== undefined) list.push(edge.to);
    // 미지 노드를 가리키는 간선은 순환 검출 대상이 아니다(validatePlanDrafts 의 unknown_dependency 가 별도로 잡는다).
  }

  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(w) as number));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, indexOf.get(w) as number));
      }
    }

    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  }

  for (const node of graph.nodes) {
    if (!indexOf.has(node)) strongconnect(node);
  }

  const nodePosition = new Map<string, number>(graph.nodes.map((n, i) => [n, i]));
  const selfEdgeSet = new Set(kindEdges.filter((e) => e.from === e.to).map((e) => e.from));

  const cycles: string[][] = [];
  for (const component of sccs) {
    const isCycle =
      component.length >= 2 ||
      (includeSelfEdges && component.length === 1 && selfEdgeSet.has(component[0] as string));
    if (!isCycle) continue;
    const sorted = [...component].sort(
      (a, b) => (nodePosition.get(a) ?? 0) - (nodePosition.get(b) ?? 0),
    );
    cycles.push(sorted);
  }
  cycles.sort(
    (a, b) => (nodePosition.get(a[0] as string) ?? 0) - (nodePosition.get(b[0] as string) ?? 0),
  );
  return cycles;
}

/** memberTaskIds: 참조 가능한 기존 member(첫 계획은 빈 배열). 그래프 이슈만 낸다 — 순서: 중복 → 미지
 * 의존 → 미지 부모 → 자기 부모 → 부모 순환 → 의존 순환. 부모 간선은 의존 충족·의존 순환에 참여하지
 * 않는다. */
export function validatePlanDrafts(
  drafts: readonly PlanTaskDraft[],
  memberTaskIds: readonly TaskId[],
): readonly PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const draftRefSet = new Set<string>();
  const memberSet = new Set<string>(memberTaskIds);

  for (const draft of drafts) {
    if (draftRefSet.has(draft.draftRef)) {
      issues.push({ kind: "duplicate_draft_ref", draftRef: draft.draftRef });
    }
    draftRefSet.add(draft.draftRef);
  }

  function isKnownRef(ref: TaskRef): boolean {
    if ("draftRef" in ref) return draftRefSet.has(ref.draftRef);
    return memberSet.has(ref.taskId);
  }

  for (const draft of drafts) {
    for (const dep of draft.dependsOn) {
      if (!isKnownRef(dep)) {
        issues.push({ kind: "unknown_dependency", draftRef: draft.draftRef, ref: dep });
      }
    }
  }
  for (const draft of drafts) {
    if (draft.parent !== undefined && !isKnownRef(draft.parent)) {
      issues.push({ kind: "unknown_parent", draftRef: draft.draftRef, ref: draft.parent });
    }
  }
  for (const draft of drafts) {
    if (
      draft.parent !== undefined &&
      "draftRef" in draft.parent &&
      draft.parent.draftRef === draft.draftRef
    ) {
      issues.push({ kind: "self_parent", draftRef: draft.draftRef });
    }
  }

  const graph = planRelationGraph(drafts);
  for (const cycle of findParentCycles(graph)) {
    issues.push({ kind: "parent_cycle", draftRefs: cycle });
  }
  const cycles = findDependencyCycles(graph);
  for (const cycle of cycles) {
    issues.push({ kind: "dependency_cycle", draftRefs: cycle });
  }

  return issues;
}

/** fromEventId 에서 causationId 를 따라간 이벤트 ID 목록(자신 포함, 스트림 밖 참조에서 멈춤). */
export function causalChain(
  events: readonly WorkflowEventEnvelope[],
  fromEventId: string,
): readonly string[] {
  const byId = new Map<string, WorkflowEventEnvelope>();
  for (const event of events) byId.set(event.id, event);

  const chain: string[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = fromEventId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    chain.push(currentId);
    const current: WorkflowEventEnvelope | undefined = byId.get(currentId);
    if (current === undefined) break;
    currentId = current.causationId;
  }
  return chain;
}
