/**
 * `adde session <new|ls|show|clear|stop|resume|rm>` — 세션 생성·목록·상세·초기화·중지·재개·삭제.
 */
import { readFile } from "node:fs/promises";
import { defaultBase, vaultPaths } from "../shared/paths.js";
import { atomicWrite } from "../shared/fs-atomic.js";
import { withSessionManager, loadProjectConfOrThrow } from "./session-manager-helper.js";
import { submitControl } from "../core/control-queue.js";
import type { ControlResult } from "../core/control-queue.js";
import { planSessionRemoval, executeSessionRemoval } from "../core/session-removal.js";
import { renderStoppedNote } from "../surfaces/markdown/inbox.js";
import { createPrompter, askChoice } from "./prompt.js";
import type { Prompter } from "./prompt.js";
import { findSub } from "./spec.js";
import { table } from "./table.js";
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

export interface RunSessionDeps {
  prompter?: Prompter;
  interactive?: boolean;
  base?: string;
}

/** 데몬 흡수 미확인 시 공용 거부 문구(FR-022 — 무동작 성공 보고 금지). */
const DAEMON_UNCONFIRMED_MSG =
  "데몬이 요청을 가져갔으나 결과를 확인할 수 없습니다 — adde restart <proj> 후 재시도하세요.";

type StopResultValue = "stopped" | "scheduled" | "already" | "mismatch";

function isStopResultValue(v: string | undefined): v is StopResultValue {
  return v === "stopped" || v === "scheduled" || v === "already" || v === "mismatch";
}

function stopResultLine(result: StopResultValue): string {
  switch (result) {
    case "stopped":
      return "세션이 중지되었습니다.";
    case "scheduled":
      return "중지가 예약되었습니다 — 진행 중인 작업이 끝나면 자동으로 중지됩니다.";
    case "already":
      return "이미 해당 상태입니다(중지됨 또는 예약됨).";
    case "mismatch":
      return "상태 불일치 — 이미 중지되었거나 대상이 아닙니다.";
  }
}

async function handleNew(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(
    proj,
    async (sm) => {
      const result = await sm.create({
        ...(typeof p.flags["engine"] === "string" ? { engine: p.flags["engine"] } : {}),
        ...(typeof p.flags["title"] === "string" ? { title: p.flags["title"] } : {}),
        ...(typeof p.flags["engine-args"] === "string"
          ? { engineArgs: p.flags["engine-args"] }
          : {}),
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
    },
    deps.base,
  );
}

async function handleList(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(
    proj,
    async (sm) => {
      // 정렬은 항상 시각(최근 활동) 기준 — 식별자 사전순에 의존하지 않는다.
      const rows = [...sm.list()].sort(
        (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.sid.localeCompare(b.sid),
      );
      if (p.flags["json"] === true) {
        process.stdout.write(JSON.stringify({ v: 1, sessions: rows }, null, 2) + "\n");
        return EXIT.OK;
      }
      if (rows.length === 0) {
        process.stdout.write("(세션 없음)\n");
        return EXIT.OK;
      }
      // 세션 **레코드** 뷰 — 데몬 기동 여부와 무관하게 설정 루트의 레코드만 읽는다. 엔진 상주 여부
      // (PRESENT)는 데몬 상태에 의존하므로 여기 싣지 않고 `adde status` 가 담당한다.
      process.stdout.write(
        table(
          ["SID", "STATUS", "ENGINE", "TITLE", "LAST_ACTIVITY"],
          rows.map((r) => [r.sid, r.status, r.engine, r.title ?? "-", r.lastActivityAt]),
        ) + "\n",
      );
      return EXIT.OK;
    },
    deps.base,
  );
}

async function handleShow(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(
    proj,
    async (sm) => {
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
            stopReason: rec.stopReason,
            stoppedAt: rec.stoppedAt,
            stopPending: rec.stopPending,
            notices: rec.notices,
            storageLayout: rec.storageLayout ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      return EXIT.OK;
    },
    deps.base,
  );
}

async function handleClear(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  return withSessionManager(
    proj,
    async (sm) => {
      const { next } = await sm.clear(sid);
      await sm.registerBinding(next, {
        surface: "markdown",
        address: `sessions/${next}/inbox.md`,
        sid: next,
      });
      process.stdout.write(`세션 초기화됨(승계): ${sid} → ${next}\n`);
      return EXIT.OK;
    },
    deps.base,
  );
}

/** control 큐 결과(§4 프로토콜)를 CLI 종료코드로 — acked 는 데몬 결과를, unclaimed 는 `apply` 로
 * CLI 직접 적용을, unconfirmed 는 거부(무동작 성공 보고 금지)를 반환한다. */
async function resolveViaControl(
  op: "stop" | "resume",
  base: string,
  proj: string,
  sid: string,
  apply: () => Promise<{ ok: boolean; line: string; exit: number }>,
): Promise<number> {
  const submitted = await submitControl({ base, proj, op, sid });
  if (submitted.kind === "acked") {
    const r: ControlResult = submitted.result;
    const stopResult = isStopResultValue(r.result) ? r.result : undefined;
    if (!r.ok) {
      // stop 은 "already"(이미 중지·예약됨)도 mismatch 와 동일하게 실패로 보고한다(design.md §3
      // 안내 지점 18) — 친화적 문구가 있으면 그것을, 없으면 raw reason 을 보여준다.
      const message =
        op === "stop" && stopResult ? stopResultLine(stopResult) : (r.reason ?? "실패");
      process.stderr.write(groupError("session", message) + "\n");
      return EXIT.FAIL;
    }
    process.stdout.write(
      `${op === "stop" && stopResult ? stopResultLine(stopResult) : "세션이 재개되었습니다."}\n`,
    );
    return EXIT.OK;
  }
  if (submitted.kind === "unconfirmed") {
    process.stderr.write(groupError("session", DAEMON_UNCONFIRMED_MSG) + "\n");
    return EXIT.FAIL;
  }
  // unclaimed — 흡수자 없음(데몬 미상주 등) → CLI 가 직접 적용.
  const applied = await apply();
  if (!applied.ok) {
    process.stderr.write(groupError("session", applied.line) + "\n");
    return applied.exit;
  }
  process.stdout.write(`${applied.line}\n`);
  return applied.exit;
}

async function handleStop(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  const base = deps.base ?? defaultBase();
  return resolveViaControl("stop", base, proj, sid, () =>
    withSessionManager(
      proj,
      async (sm) => {
        const r = await sm.stop(sid, { reason: "cli", source: "cli" });
        // "already"(이미 중지·예약됨)도 mismatch 와 동일하게 실패로 보고한다 — 무동작 성공 금지.
        if (r.result === "mismatch" || r.result === "already") {
          return { ok: false, line: stopResultLine(r.result), exit: EXIT.FAIL };
        }
        return { ok: true, line: stopResultLine(r.result), exit: EXIT.OK };
      },
      deps.base,
    ),
  );
}

async function handleResume(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  if (!sid) {
    // sid 생략 — 대상 열거만(목록 표면을 신설하지 않는다, FR-021).
    return withSessionManager(
      proj,
      async (sm) => {
        const candidates = sm.resumeCandidates();
        if (candidates.length === 0) {
          process.stderr.write(groupError("session", "재개할 중지 세션이 없습니다.") + "\n");
          return EXIT.FAIL;
        }
        process.stdout.write(
          `재개 대상 ${candidates.length}건 — 목록은 \`adde session ls ${proj}\` 로 확인 후 ` +
            `\`adde session resume ${proj} <sid>\` 를 실행하세요.\n`,
        );
        return EXIT.USAGE;
      },
      deps.base,
    );
  }
  const base = deps.base ?? defaultBase();
  return resolveViaControl("resume", base, proj, sid, () =>
    withSessionManager(
      proj,
      async (sm) => {
        const r = await sm.resume(sid);
        if (r.result === "resumed")
          return { ok: true, line: "세션이 재개되었습니다.", exit: EXIT.OK };
        return { ok: false, line: r.reason ?? "재개 실패", exit: EXIT.FAIL };
      },
      deps.base,
    ),
  );
}

/** 삭제 전 데몬 흡수 확인 → 실제 fs 삭제(→ 일반 제거는 노트 1회 교체까지). */
async function removeConfirmed(
  base: string,
  proj: string,
  sid: string,
  mode: "purge" | "record",
  vaultRoot: string,
): Promise<number> {
  const submitted = await submitControl({ base, proj, op: "remove", sid });
  if (submitted.kind === "unconfirmed") {
    process.stderr.write(groupError("session", DAEMON_UNCONFIRMED_MSG) + "\n");
    return EXIT.FAIL;
  }
  if (submitted.kind === "acked" && !submitted.result.ok) {
    process.stderr.write(groupError("session", submitted.result.reason ?? "제거 확인 실패") + "\n");
    return EXIT.FAIL;
  }

  const plan = await planSessionRemoval({ base, proj, vaultRoot, sid, mode });
  if (!plan) {
    process.stderr.write(groupError("session", `대상 없음: ${sid}`) + "\n");
    return EXIT.FAIL;
  }
  const result = await executeSessionRemoval(plan);
  if (result.failures.length > 0) {
    process.stderr.write(
      groupError(
        "session",
        `일부 삭제 실패: ${result.failures.map((f) => `${f.path}(${f.reason})`).join(", ")}`,
      ) + "\n",
    );
    return EXIT.FAIL;
  }

  if (mode === "record") {
    // 일반 제거 후 남는 입력 노트를 "제거됨 안내형" 으로 1회 교체(FR-020 — 내용 보존, 재생성 불필요).
    const vp = vaultPaths(vaultRoot, proj, sid);
    let content = "";
    try {
      content = await readFile(vp.inboxNote, "utf8");
    } catch {
      // 노트 부재 — 교체할 것도 없다.
    }
    if (content.length > 0) {
      const rendered = renderStoppedNote(content.split("\n"), { kind: "removed", reason: "" });
      await atomicWrite(vp.inboxNote, rendered.join("\n") + "\n");
    }
    process.stdout.write(
      `세션 제거됨(일반): ${sid} — vault(노트·기록)는 보존되며 재생성 명령이 필요하지 않습니다.\n`,
    );
    return EXIT.OK;
  }

  process.stdout.write(`세션 완전 제거됨: ${sid}\n`);
  if (plan.legacyEra) {
    process.stdout.write(
      "한계: 배치 변경 이전 세션이라 이전 위치의 본문(blob)이 남을 수 있습니다 — " +
        "완전 보장은 `adde factory-reset` 으로만 가능합니다.\n",
    );
  }
  return EXIT.OK;
}

async function handleRemove(p: ParseResult, deps: RunSessionDeps): Promise<number> {
  const [proj, sid] = p.positional;
  if (!proj || !sid) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }
  const base = deps.base ?? defaultBase();
  const purgeFlag = p.flags["purge"] === true;

  if (purgeFlag) {
    const conf = await loadProjectConfOrThrow(base, proj);
    return removeConfirmed(base, proj, sid, "purge", conf.vault);
  }

  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  if (!interactive) {
    process.stderr.write(buildGroupUsage("usage.session") + "\n");
    return EXIT.USAGE;
  }

  const conf = await loadProjectConfOrThrow(base, proj);
  // mode 확정 전 인벤토리는 완전 제거 기준으로 조회한다 — 대상 경로·턴 수는 모드와 무관하게 그
  // 세션 소유분을 가리키고, 실제 삭제 범위(vault 포함 여부)만 이후 선택에 따라 갈린다.
  const plan = await planSessionRemoval({ base, proj, vaultRoot: conf.vault, sid, mode: "purge" });
  if (!plan) {
    process.stderr.write(groupError("session", `대상 없음: ${sid}`) + "\n");
    return EXIT.FAIL;
  }

  const prompter = deps.prompter ?? createPrompter();
  try {
    process.stdout.write(
      `삭제 대상: ${sid} — 턴 ${plan.turnCount}개` +
        `${plan.inFlightTurn ? " · 진행 중 턴 있음" : ""}` +
        `${plan.legacyEra ? " · legacy 구간(완전 제거해도 이전 배치 본문이 남을 수 있음)" : ""}\n`,
    );
    const choice = await askChoice(prompter.ask, "무엇을 하시겠습니까?", [
      { value: "purge" as const, label: "완전 제거(복구 불가 — 대화 원본까지 삭제)" },
      { value: "record" as const, label: "일반 제거(목록에서만 제거 — vault 는 보존)" },
      { value: "cancel" as const, label: "취소" },
    ]);
    if (choice === "cancel") {
      process.stdout.write("취소되었습니다 — 아무것도 지우지 않았습니다.\n");
      return EXIT.FAIL;
    }
    return await removeConfirmed(base, proj, sid, choice, conf.vault);
  } finally {
    if (!deps.prompter) prompter.close();
  }
}

export async function runSession(
  argv: readonly string[],
  deps: RunSessionDeps = {},
): Promise<number> {
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
        return await handleNew(p, deps);
      case "ls":
        return await handleList(p, deps);
      case "show":
        return await handleShow(p, deps);
      case "clear":
        return await handleClear(p, deps);
      case "stop":
        return await handleStop(p, deps);
      case "resume":
        return await handleResume(p, deps);
      case "rm":
        return await handleRemove(p, deps);
      default:
        process.stderr.write(unknownGroupSub("session", sub, "usage.session") + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    process.stderr.write(groupError("session", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
}
