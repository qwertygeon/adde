/**
 * TaskType 출력 선언 해석 — 선언된 스키마 그대로이거나, 입력 필드가 출력 스키마를 정하는 경우 입력에
 * 그 필드가 있을 때만 그 값을 스키마로 돌려준다.
 */
import * as z from "zod";
import type { TaskTypeDescriptor } from "./descriptors.js";

export type ResolvedOutput =
  | { readonly name: string; readonly source: "declared"; readonly schema: z.ZodType }
  | {
      readonly name: string;
      readonly source: "input_field";
      readonly field: string;
      readonly schema: unknown;
    };

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function resolveOne(
  name: string,
  declaration: unknown,
  input: unknown,
): ResolvedOutput | undefined {
  if (declaration instanceof z.ZodType) return { name, source: "declared", schema: declaration };
  if (isPlainObject(declaration) && typeof declaration["outputSchemaFromInput"] === "string") {
    const field = declaration["outputSchemaFromInput"];
    if (!isPlainObject(input) || !Object.hasOwn(input, field) || input[field] === undefined) {
      return undefined;
    }
    return { name, source: "input_field", field, schema: input[field] };
  }
  return undefined;
}

/** 선언 순서. 입력 필드에서 오는 출력은 입력(객체)에 그 필드가 있을 때만 포함. */
export function resolveTaskOutputs(
  descriptor: TaskTypeDescriptor,
  input: unknown,
): readonly ResolvedOutput[] {
  const out: ResolvedOutput[] = [];
  for (const [name, declaration] of Object.entries(descriptor.outputs)) {
    const resolved = resolveOne(name, declaration, input);
    if (resolved !== undefined) out.push(resolved);
  }
  return out;
}

export function resolveTaskOutput(
  descriptor: TaskTypeDescriptor,
  input: unknown,
  name: string,
): ResolvedOutput | undefined {
  if (!Object.hasOwn(descriptor.outputs, name)) return undefined;
  return resolveOne(name, descriptor.outputs[name], input);
}
