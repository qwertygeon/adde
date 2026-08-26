/**
 * `adde vault rebuild <proj>` — 이벤트 기록에서 노트·dedup 원장을 재생성(FR-016·FR-034·NFR-006).
 */
import { defaultBase } from "../shared/paths.js";
import { rebuild } from "../record/rebuild.js";
import { project } from "../record/projector.js";
import { defaultRetentionPolicy } from "../record/retention.js";
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

async function handleRebuild(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.vault") + "\n");
    return EXIT.USAGE;
  }
  const base = defaultBase();
  const sid = typeof p.flags["sid"] === "string" ? p.flags["sid"] : undefined;

  return withSessionManager(proj, async (sm, conf) => {
    const retention = conf["vault.backup"]
      ? {
          backupDir: conf["vault.backup"],
          retentionDays: conf["vault.retention_days"],
          now: () => new Date(),
        }
      : defaultRetentionPolicy();
    const report = await rebuild(base, conf.vault, proj, { ...(sid ? { sid } : {}), retention });

    // GAP-012 후처리 — 세션·프로젝트 노트에 상태·엔진 메타를 다시 주입(rebuild 자체는 L1 이라
    // SessionRecord 를 모른다).
    const targets = sid ? [sid] : report.sids;
    for (const s of targets) {
      const rec = sm.get(s);
      if (!rec) continue;
      await project(
        { base, vaultRoot: conf.vault, proj, sid: s },
        {
          retention,
          sessionMeta: {
            engine: rec.engine,
            engineRef: rec.engineRef,
            status: rec.status,
            title: rec.title,
            createdAt: rec.createdAt,
            lastActivityAt: rec.lastActivityAt,
            warnings: rec.warnings,
          },
          projectSessions: sm.list().map((r) => ({
            sid: r.sid,
            status: r.status,
            title: r.title,
            lastActivityAt: r.lastActivityAt,
          })),
        },
      );
    }

    if (p.flags["json"] === true) {
      process.stdout.write(JSON.stringify({ v: 1, ...report }, null, 2) + "\n");
    } else {
      process.stdout.write(
        `재생성 완료: 세션 ${report.sids.length}개, 턴 ${report.turnsRendered}건, dedup ${report.dedupEntries}건.\n`,
      );
    }
    return EXIT.OK;
  });
}

export async function runVault(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(buildGroupUsage("usage.vault") + "\n");
    return EXIT.OK;
  }
  const subSpec = findSub("vault", sub);
  if (!subSpec) {
    process.stderr.write(unknownGroupSub("vault", sub, "usage.vault") + "\n");
    return EXIT.FAIL;
  }
  const p = parseCommand(subSpec, rest);
  if (p.error) {
    process.stderr.write(
      `${groupError("vault", flagErrorText(p.error))}\n\n${buildGroupUsage("usage.vault")}\n`,
    );
    return EXIT.USAGE;
  }
  try {
    if (subSpec.name === "rebuild") return await handleRebuild(p);
    process.stderr.write(unknownGroupSub("vault", sub, "usage.vault") + "\n");
    return EXIT.FAIL;
  } catch (err) {
    process.stderr.write(groupError("vault", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}
