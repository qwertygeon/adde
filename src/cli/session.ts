/**
 * `adde session <new|ls|show|clear|rm>` — 세션 생성·목록·상세·초기화·삭제(FR-001·FR-003·FR-004·FR-005).
 */
import { rm } from "node:fs/promises";
import { defaultBase, sessionPaths, vaultPaths } from "../shared/paths.js";
import { withSessionManager } from "./session-manager-helper.js";
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

async function handleNew(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const result = await sm.create({
      ...(typeof p.flags["engine"] === "string" ? { engine: p.flags["engine"] } : {}),
      ...(typeof p.flags["title"] === "string" ? { title: p.flags["title"] } : {}),
      ...(typeof p.flags["engine-args"] === "string" ? { engineArgs: p.flags["engine-args"] } : {}),
    });
    await sm.registerBinding(result.sid, {
      surface: "markdown",
      address: `sessions/${result.sid}/inbox.md`,
      sid: result.sid,
    });
    if (p.flags["json"] === true) {
      process.stdout.write(JSON.stringify({ v: 1, ...result }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `세션 생성됨: ${result.sid} (같은 실행 경로의 활성 세션 ${result.activeSameCwd}개)\n`,
      );
      if (result.warnings.includes("engine-no-resume")) {
        process.stdout.write("경고: 이 엔진은 재기동 후 맥락이 유지되지 않습니다.\n");
      }
    }
    return EXIT.OK;
  });
}

async function handleList(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const rows = sm.list();
    if (p.flags["json"] === true) {
      process.stdout.write(JSON.stringify({ v: 1, sessions: rows }, null, 2) + "\n");
      return EXIT.OK;
    }
    if (rows.length === 0) {
      process.stdout.write("(세션 없음)\n");
      return EXIT.OK;
    }
    for (const r of rows) {
      process.stdout.write(
        `${r.sid}\t${r.status}\t${r.title ?? "(제목 없음)"}\t${r.lastActivityAt}\n`,
      );
    }
    return EXIT.OK;
  });
}

async function handleShow(p: ParseResult): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const rec = sm.get(sid);
    if (!rec) {
      process.stderr.write(groupError("session", `세션 없음: ${sid}`) + "\n");
      return EXIT.FAIL;
    }
    process.stdout.write(
      JSON.stringify(
        {
          v: 1,
          sid: rec.sid,
          engine: rec.engine,
          engineRef: rec.engineRef,
          status: rec.status,
          title: rec.title,
          createdAt: rec.createdAt,
          lastActivityAt: rec.lastActivityAt,
          successorOf: rec.successorOf,
          engineArgs: rec.engineArgs,
          warnings: rec.warnings,
          bindings: rec.bindings,
        },
        null,
        2,
      ) + "\n",
    );
    return EXIT.OK;
  });
}

async function handleClear(p: ParseResult): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(proj, async (sm) => {
    const { next } = await sm.clear(sid);
    process.stdout.write(`세션 초기화됨(승계): ${sid} → ${next}\n`);
    return EXIT.OK;
  });
}

async function handleRemove(p: ParseResult): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  const purge = p.flags["purge"] === true;
  return withSessionManager(proj, async (sm, conf) => {
    await sm.remove(sid, { purge });
    if (purge) {
      const base = defaultBase();
      const sp = sessionPaths(base, proj, sid);
      await rm(sp.queueDir, { recursive: true, force: true }).catch(() => {});
      await rm(sp.processingDir, { recursive: true, force: true }).catch(() => {});
      await rm(sp.recordFile, { force: true }).catch(() => {});
      const vp = vaultPaths(conf.vault, proj, sid);
      await rm(vp.sessionDir, { recursive: true, force: true }).catch(() => {});
    }
    process.stdout.write(`세션 삭제됨: ${sid}${purge ? "(--purge)" : ""}\n`);
    return EXIT.OK;
  });
}

export async function runSession(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.OK;
  }
  const subSpec = findSub("session", sub);
  if (!subSpec) {
    process.stderr.write(unknownGroupSub("session", sub, "usage.session") + "\n");
    return EXIT.FAIL;
  }
  const p = parseCommand(subSpec, rest);
  if (p.error) {
    process.stderr.write(
      `${groupError("session", flagErrorText(p.error))}\n\n${buildGroupUsage("usage.session")}\n`,
    );
    return EXIT.USAGE;
  }
  try {
    switch (subSpec.name) {
      case "new":
        return await handleNew(p);
      case "ls":
        return await handleList(p);
      case "show":
        return await handleShow(p);
      case "clear":
        return await handleClear(p);
      case "rm":
        return await handleRemove(p);
      default:
        process.stderr.write(unknownGroupSub("session", sub, "usage.session") + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    process.stderr.write(groupError("session", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}
