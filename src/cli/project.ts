/**
 * `adde project <add|set|show|ls|rm>` — 프로젝트 생성·설정 조회/편집·목록·삭제.
 */
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultBase,
  projectPaths,
  assertSafeSegment,
  normalizeUserPath,
} from "../shared/paths.js";
import { atomicWrite } from "../shared/fs-atomic.js";
import {
  parseProjectConf,
  serializeProjectConf,
  validateProjectConf,
  ProjectConfParseError,
  DEFAULT_STOP_AFTER_MIN,
  DEFAULT_NOTICES_CAP,
} from "../shared/conf.js";
import type { ProjectConf } from "../shared/conf.js";
import { PROJECT_KEY_DESCRIPTORS, applyEdits } from "../shared/project-schema.js";
import type { KeyEdit } from "../shared/project-schema.js";
import { DEFAULT_AUTOPASS_DENYLIST } from "../shared/deny-match.js";
import { applyProjectFileMode } from "../shared/file-mode.js";
import { ENGINE_IDS } from "../engines/index.js";
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

async function handleAdd(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.project") + "\n");
    return EXIT.USAGE;
  }
  assertSafeSegment("proj", proj);
  const base = defaultBase();
  const pp = projectPaths(base, proj);
  if (await exists(pp.projectConf)) {
    process.stderr.write(groupError("project", `프로젝트 "${proj}" 는 이미 존재합니다.`) + "\n");
    return EXIT.FAIL;
  }
  const vaultRaw = p.flags["vault"];
  if (typeof vaultRaw !== "string" || vaultRaw.length === 0) {
    process.stderr.write(
      groupError("project", "--vault 는 필수입니다(임의 기본 위치를 생성하지 않습니다).") + "\n",
    );
    return EXIT.USAGE;
  }

  const permTier = typeof p.flags["perm-tier"] === "string" ? p.flags["perm-tier"] : "acp";
  let denylist = csv(typeof p.flags["denylist"] === "string" ? p.flags["denylist"] : undefined);
  let seededDefaultDenylist = false;
  if (permTier === "autopass" && denylist.length === 0 && p.flags["denylist"] === undefined) {
    denylist = [...DEFAULT_AUTOPASS_DENYLIST];
    seededDefaultDenylist = true;
  }

  // 위험 명령 하드 차단 시드 — 내장 위험 목록과 명시 지정분의 합집합(방어 심화, 중복 제거).
  const explicitHardDeny = csv(
    typeof p.flags["hard-deny"] === "string" ? p.flags["hard-deny"] : undefined,
  );
  const hardDeny =
    p.flags["safe-defaults"] === true
      ? [...new Set([...DEFAULT_AUTOPASS_DENYLIST, ...explicitHardDeny])]
      : explicitHardDeny;

  const conf: ProjectConf = {
    v: 1,
    warnings: [],
    vault: normalizeUserPath(vaultRaw),
    engine: typeof p.flags["engine"] === "string" ? p.flags["engine"] : "acp",
    perm_tier: permTier,
    acp_version: "v1",
    allowlist: csv(typeof p.flags["allowlist"] === "string" ? p.flags["allowlist"] : undefined),
    denylist,
    hard_deny: hardDeny,
    auto_restart: true,
    auto_resume: true,
    idle_hibernate: true,
    hibernate_after_min: 30,
    idle_stop: true,
    stop_after_min: DEFAULT_STOP_AFTER_MIN,
    max_active_engines: 3,
    auto_relaunch: true,
    "markdown.palette": true,
    "markdown.notices_cap": DEFAULT_NOTICES_CAP,
    "vault.retention_days":
      typeof p.flags["retention-days"] === "string"
        ? Number.parseInt(p.flags["retention-days"], 10) || 2
        : 2,
    "vault.sync_provider":
      typeof p.flags["sync-provider"] === "string" ? p.flags["sync-provider"] : "local",
    ...(typeof p.flags["cwd"] === "string" ? { cwd: normalizeUserPath(p.flags["cwd"]) } : {}),
    ...(typeof p.flags["backup"] === "string"
      ? { "vault.backup": normalizeUserPath(p.flags["backup"]) }
      : {}),
  };

  const errors = validateProjectConf(conf, { base, proj, engineIds: ENGINE_IDS });
  if (errors.length > 0) {
    process.stderr.write(groupError("project", errors.join("; ")) + "\n");
    return EXIT.FAIL;
  }

  await mkdir(pp.root, { recursive: true });
  await atomicWrite(pp.projectConf, serializeProjectConf(conf));
  // 내부 디렉터리 권한을 conf 선언대로 적용한다(기본 `private`=0700) — 큐·처리 중 봉투에는 프롬프트
  // 본문이 들어가므로 다중 사용자 호스트에서 타 로컬 유저 열람 대상이 되지 않게 한다.
  // 실패해도 생성 자체는 되돌리지 않되(반쯤 만들어진 프로젝트 회피) 사실은 알린다.
  await applyProjectFileMode(base, proj, conf.file_mode).catch((err: unknown) => {
    process.stderr.write(
      `내부 디렉터리 권한 잠금 실패(파일이 타 사용자에 노출될 수 있음): ${errMsg(err)}\n`,
    );
  });
  process.stdout.write(`프로젝트 "${proj}" 생성됨(vault=${conf.vault}).\n`);
  if (seededDefaultDenylist) {
    process.stdout.write(
      `autopass 티어에 거부 목록이 지정되지 않아 내장 기본 거부 목록 ${denylist.length}건을 시드했습니다.\n`,
    );
  }
  if (p.flags["safe-defaults"] === true) {
    process.stdout.write(
      `내장 위험 목록을 하드 차단(hard_deny) ${hardDeny.length}건으로 시드했습니다.\n`,
    );
  }
  return EXIT.OK;
}

async function handleSet(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.project") + "\n");
    return EXIT.USAGE;
  }
  const base = defaultBase();
  const pp = projectPaths(base, proj);
  let conf: ProjectConf;
  try {
    conf = parseProjectConf(await readFile(pp.projectConf, "utf8"));
  } catch (err) {
    process.stderr.write(groupError("project", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }

  const edits: KeyEdit[] = [];
  const rest = p.positional.slice(1);
  const listOps: Array<[string, "add" | "remove", string]> = [
    ["add-allow", "add", "allowlist"],
    ["rm-allow", "remove", "allowlist"],
    ["add-deny", "add", "denylist"],
    ["rm-deny", "remove", "denylist"],
    ["add-hard-deny", "add", "hard_deny"],
    ["rm-hard-deny", "remove", "hard_deny"],
  ];
  for (const [flag, op, key] of listOps) {
    const raw = p.flags[flag];
    if (typeof raw === "string") {
      for (const v of csv(raw)) edits.push({ key, op, value: v });
    }
  }
  if (p.flags["unset"] === true) {
    for (const key of rest) edits.push({ key, op: "unset" });
  } else if (rest.length >= 2 && edits.length === 0) {
    edits.push({ key: rest[0]!, op: "set", value: rest.slice(1).join(" ") });
  }

  if (edits.length === 0) {
    process.stderr.write(groupError("project", "편집할 키/값을 지정하세요.") + "\n");
    return EXIT.USAGE;
  }

  const result = applyEdits(conf, edits);
  if (result.errors.length > 0) {
    process.stderr.write(groupError("project", result.errors.join("; ")) + "\n");
    return EXIT.FAIL;
  }
  await atomicWrite(pp.projectConf, serializeProjectConf(result.conf));
  process.stdout.write(`프로젝트 "${proj}" 설정이 갱신되었습니다.\n`);
  return EXIT.OK;
}

async function handleShow(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.project") + "\n");
    return EXIT.USAGE;
  }
  const base = defaultBase();
  const pp = projectPaths(base, proj);
  let conf: ProjectConf;
  try {
    conf = parseProjectConf(await readFile(pp.projectConf, "utf8"));
  } catch (err) {
    process.stderr.write(groupError("project", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  if (p.flags["json"] === true) {
    process.stdout.write(JSON.stringify({ v: 1, proj, conf }, null, 2) + "\n");
    return EXIT.OK;
  }
  if (p.flags["defaults"] === true) {
    for (const d of PROJECT_KEY_DESCRIPTORS) {
      process.stdout.write(
        `${d.key} = ${d.default !== undefined ? String(d.default) : "(없음)"}\n`,
      );
    }
    return EXIT.OK;
  }
  for (const [k, v] of Object.entries(conf)) {
    process.stdout.write(`${k} = ${Array.isArray(v) ? v.join(",") : String(v)}\n`);
  }
  return EXIT.OK;
}

async function handleList(p: ParseResult): Promise<number> {
  const base = defaultBase();
  const projectsRoot = join(base, "projects");
  let names: string[];
  try {
    names = (await readdir(projectsRoot)).filter((n) => !n.startsWith("."));
  } catch {
    names = [];
  }
  const rows: string[] = [];
  for (const name of names) {
    const st = await stat(join(projectsRoot, name)).catch(() => null);
    if (st?.isDirectory()) rows.push(name);
  }
  if (p.flags["json"] === true) {
    process.stdout.write(JSON.stringify({ v: 1, projects: rows }, null, 2) + "\n");
    return EXIT.OK;
  }
  process.stdout.write(rows.length > 0 ? rows.join("\n") + "\n" : "(등록된 프로젝트 없음)\n");
  return EXIT.OK;
}

async function handleRemove(p: ParseResult): Promise<number> {
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildGroupUsage("usage.project") + "\n");
    return EXIT.USAGE;
  }
  if (p.flags["force"] !== true) {
    process.stderr.write(groupError("project", "삭제는 --force 확인이 필요합니다.") + "\n");
    return EXIT.FAIL;
  }
  const base = defaultBase();
  const pp = projectPaths(base, proj);
  await rm(pp.root, { recursive: true, force: true });
  process.stdout.write(`프로젝트 "${proj}" 삭제됨(설정 루트만 — vault 데이터는 보존됩니다).\n`);
  return EXIT.OK;
}

export async function runProject(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(buildGroupUsage("usage.project") + "\n");
    return EXIT.OK;
  }
  const subSpec = findSub("project", sub);
  if (!subSpec) {
    process.stderr.write(unknownGroupSub("project", sub, "usage.project") + "\n");
    return EXIT.FAIL;
  }
  const p = parseCommand(subSpec, rest);
  if (p.error) {
    process.stderr.write(
      `${groupError("project", flagErrorText(p.error))}\n\n${buildGroupUsage("usage.project")}\n`,
    );
    return EXIT.USAGE;
  }
  try {
    switch (subSpec.name) {
      case "add":
        return await handleAdd(p);
      case "set":
        return await handleSet(p);
      case "show":
        return await handleShow(p);
      case "ls":
        return await handleList(p);
      case "rm":
        return await handleRemove(p);
      default:
        process.stderr.write(unknownGroupSub("project", sub, "usage.project") + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    process.stderr.write(
      groupError("project", err instanceof ProjectConfParseError ? err.message : errMsg(err)) +
        "\n",
    );
    return EXIT.FAIL;
  }
}
