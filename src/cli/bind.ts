/**
 * `adde bind <add|rm|ls>` — 채널 바인딩 연결/해제/목록(FR-024·FR-027·FR-030).
 * stub 채널(telegram·discord)로의 바인딩 생성은 거부된다(SC-034).
 */
import { withSessionManager } from "./session-manager-helper.js";
import { SURFACE_REGISTRY } from "../surfaces/index.js";
import { findSub } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";
import {
  buildGroupUsage,
  unknownGroupSub,
  groupError,
  flagErrorText,
  EXIT,
} from "../core/messages.js";
import { errMsg } from "../shared/errors.js";

async function handleAdd(p: ParseResult): Promise<number> {
  const [proj, sid] = p.positional;
  const surface = p.flags["surface"];
  const address = p.flags["address"];
  if (!proj || !sid || typeof surface !== "string" || typeof address !== "string") {
    process.stderr.write(buildGroupUsage("usage.bind") + "\n");
    return EXIT.USAGE;
  }
  const descriptor = SURFACE_REGISTRY[surface];
  if (!descriptor) {
    process.stderr.write(groupError("bind", `알 수 없는 surface "${surface}"`) + "\n");
    return EXIT.FAIL;
  }
  if (descriptor.status === "stub") {
    process.stderr.write(
      groupError("bind", `"${surface}" 는 미구현 채널입니다 — 바인딩 생성이 거부됩니다.`) + "\n",
    );
    return EXIT.FAIL;
  }
  return withSessionManager(proj, async (sm) => {
    if (!sm.get(sid)) {
      process.stderr.write(groupError("bind", `세션 없음: ${sid}`) + "\n");
      return EXIT.FAIL;
    }
    await sm.registerBinding(sid, { surface, address, sid });
    process.stdout.write(`바인딩 추가됨: ${surface} ${address} → ${sid}\n`);
    return EXIT.OK;
  });
}

async function handleRemove(p: ParseResult): Promise<number> {
  const [proj, sid] = p.positional;
  const surface = p.flags["surface"];
  const address = p.flags["address"];
  if (!proj || !sid || typeof surface !== "string" || typeof address !== "string") {
    process.stderr.write(buildGroupUsage("usage.bind") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const rec = sm.get(sid);
    if (!rec) {
      process.stderr.write(groupError("bind", `세션 없음: ${sid}`) + "\n");
      return EXIT.FAIL;
    }
    if (!rec.bindings.some((b) => b.surface === surface && b.address === address)) {
      process.stderr.write(
        groupError("bind", `바인딩 없음: ${surface} ${address} (${sid})`) + "\n",
      );
      return EXIT.FAIL;
    }
    await sm.removeBinding(sid, { surface, address });
    process.stdout.write(`바인딩 해제됨: ${surface} ${address} → ${sid}\n`);
    return EXIT.OK;
  });
}

async function handleList(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.bind") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const rows = sm.list().flatMap((r) => r.bindings.map((b) => ({ ...b })));
    if (p.flags["json"] === true) {
      process.stdout.write(JSON.stringify({ v: 1, bindings: rows }, null, 2) + "\n");
      return EXIT.OK;
    }
    if (rows.length === 0) {
      process.stdout.write("(바인딩 없음)\n");
      return EXIT.OK;
    }
    for (const b of rows) process.stdout.write(`${b.surface}\t${b.address}\t${b.sid}\n`);
    return EXIT.OK;
  });
}

export async function runBind(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(buildGroupUsage("usage.bind") + "\n");
    return EXIT.OK;
  }
  const subSpec = findSub("bind", sub);
  if (!subSpec) {
    process.stderr.write(unknownGroupSub("bind", sub, "usage.bind") + "\n");
    return EXIT.FAIL;
  }
  const p = parseCommand(subSpec, rest);
  if (p.error) {
    process.stderr.write(
      `${groupError("bind", flagErrorText(p.error))}\n\n${buildGroupUsage("usage.bind")}\n`,
    );
    return EXIT.USAGE;
  }
  try {
    switch (subSpec.name) {
      case "add":
        return await handleAdd(p);
      case "ls":
        return await handleList(p);
      case "rm":
        return await handleRemove(p);
      default:
        process.stderr.write(unknownGroupSub("bind", sub, "usage.bind") + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    process.stderr.write(groupError("bind", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}
