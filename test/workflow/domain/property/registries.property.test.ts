// SC-020, SC-055 — property: 등록 순서 순열과 무관한 조회·구성 결정성.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTaskTypeRegistry } from "../../../../src/workflow/domain/index.js";
import type { TaskTypeDescriptor } from "../../../../src/workflow/domain/index.js";
import { probeTaskType } from "../helpers/registry-fixtures.js";

const identity = fc.record({
  id: fc.constantFrom("alpha_type", "beta_type", "gamma_type"),
  version: fc.integer({ min: 1, max: 5 }),
});

const key = (d: { readonly id: string; readonly version: number }) => `${d.id}@${d.version}`;

function descriptorsFor(ids: readonly { id: string; version: number }[]): TaskTypeDescriptor[] {
  return ids.map((d) => probeTaskType({ id: d.id, version: d.version, title: `title ${key(d)}` }));
}

/** 같은 집합의 두 순서(원래·뒤섞음). */
const setAndPermutation = fc
  .uniqueArray(identity, { selector: key, minLength: 1, maxLength: 8 })
  .chain((ids) =>
    fc.tuple(
      fc.constant(ids),
      fc.shuffledSubarray(ids, { minLength: ids.length, maxLength: ids.length }),
    ),
  );

describe("SC-020: property — 등록 순서를 바꿔도 조회·열거가 같다", () => {
  it("test_SC020_property_registration_order_permutation_same_lookup", () => {
    fc.assert(
      fc.property(setAndPermutation, ([ids, permuted]) => {
        const a = createTaskTypeRegistry(descriptorsFor(ids));
        const b = createTaskTypeRegistry(descriptorsFor(permuted));
        if (!a.ok || !b.ok) return false;
        for (const d of ids) {
          if (a.value.get(d.id, d.version)?.title !== `title ${key(d)}`) return false;
          if (b.value.get(d.id, d.version)?.title !== `title ${key(d)}`) return false;
        }
        expect(a.value.list().map(key)).toEqual(b.value.list().map(key));
        return true;
      }),
    );
  });
});

describe("SC-055: property — 등록부 구성이 결정적이다", () => {
  it("test_SC055_property_registry_construction_deterministic", () => {
    fc.assert(
      fc.property(fc.array(identity, { minLength: 1, maxLength: 8 }), (ids) => {
        const build = () =>
          createTaskTypeRegistry(
            ids.map((d, i) => probeTaskType({ id: d.id, version: d.version, title: `#${i}` })),
          );
        const first = build();
        const second = build();
        expect(first.ok).toBe(second.ok);
        if (first.ok && second.ok)
          expect(first.value.list().map(key)).toEqual(second.value.list().map(key));
        if (!first.ok && !second.ok) {
          expect(first.error).toEqual(second.error);
          expect(first.error.kind).toBe("registration_collision");
        }
        const hasDuplicate = new Set(ids.map(key)).size !== ids.length;
        expect(first.ok).toBe(!hasDuplicate);
      }),
    );
  });
});
