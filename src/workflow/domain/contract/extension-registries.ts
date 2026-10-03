/**
 * 확장점 등록 집합 전사 — the workflow contract "Extension point registries" 표의 1~2열 원문(등록
 * 집합은 `id@version` 원소 순서 그대로). 소유 문서 열은 전사하지 않는다.
 */

export const EXTENSION_REGISTERED_SETS = [
  {
    extensionPoint: "TaskType",
    registeredSet: ["confirmation@1", "agent_goal@1", "delegation@1", "notification@1"],
  },
  {
    extensionPoint: "Trigger kind",
    registeredSet: ["immediate@1", "at@1", "after@1", "dependencies_complete@1", "signal@1"],
  },
  {
    extensionPoint: "Reaction kind",
    registeredSet: [
      "notify@1",
      "request_confirmation@1",
      "execute_agent_goal@1",
      "delegate@1",
      "spawn_task@1",
      "spawn_work@1",
    ],
  },
] as const;
