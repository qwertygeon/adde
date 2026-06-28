/**
 * 레인 라이프사이클 수퍼바이저.
 * FR-001/021/022/ADR-010: lanes.d conf 스캔 → 레인별 기동·헬스.
 * adde up → source/injector/backend/gate 인스턴스화 + 기동.
 * adde down → 레인 프로세스 종료.
 */
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseLaneConf } from "../shared/conf.js";
import { lanePaths, defaultBase } from "../shared/paths.js";
import { AcpBackendImpl } from "../backend/acp/client.js";
import type { AcpBackend } from "../backend/acp/client.js";
import { createInjector } from "./injector.js";
import { createTelegramSource, createObsidianSource } from "../src-adapters/index.js";
import type { Source } from "../src-adapters/index.js";
import { gateRequestDecision } from "../gate/gate.js";

/** 런타임 ACP 어댑터 바이너리 경로. */
function resolveAdapterBin(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve("@zed-industries/claude-code-acp/package.json");
    const dir = pkg.slice(0, pkg.lastIndexOf("/package.json"));
    const candidate = join(dir, "dist", "claude-code-acp");
    return candidate;
  } catch {
    const thisDir = fileURLToPath(new URL(".", import.meta.url));
    return resolve(thisDir, "../../../node_modules/.bin/claude-code-acp");
  }
}

interface LaneHandle {
  lane: string;
  stop(): void;
}

/** 레인 기동 상태 결과. */
export interface LaneStatus {
  lane: string;
  status: "running" | "error" | "stopped";
}

/** supervisorUp 반환값. */
export interface SupervisorUpResult {
  lanes: LaneStatus[];
  message: string;
}

/** supervisorDown 반환값. */
export interface SupervisorDownResult {
  lanes: LaneStatus[];
  message: string;
}

/**
 * ACP 백엔드 팩토리 — 테스트에서 주입 가능하도록 의존을 분리.
 * (lane: string, adapterBin: string) → AcpBackend.
 * 기본값: new AcpBackendImpl(adapterBin).
 */
export type AcpFactory = (lane: string, adapterBin: string) => AcpBackend;

export interface SupervisorUpOptions {
  base?: string;
  acpFactory?: AcpFactory;
}

export interface SupervisorDownOptions {
  base?: string;
}

const activeLanes = new Map<string, LaneHandle[]>();

/**
 * `adde up <proj>` — lanes.d 의 conf 파일 스캔 → 레인별 기동.
 */
export async function supervisorUp(
  proj: string,
  opts?: SupervisorUpOptions,
): Promise<SupervisorUpResult> {
  const baseDir = opts?.base ?? defaultBase();
  const projDir = join(baseDir, proj);
  const lanesDir = join(projDir, "lanes.d");

  await mkdir(lanesDir, { recursive: true });

  let confFiles: string[];
  try {
    confFiles = (await readdir(lanesDir)).filter((f) => f.endsWith(".conf"));
  } catch {
    confFiles = [];
  }

  if (confFiles.length === 0) {
    console.log(`[supervisor] ${proj}: lanes.d 에 conf 없음`);
    return { lanes: [], message: `${proj}: 레인 0개 — lanes.d 에 conf 없음` };
  }

  const adapterBin = resolveAdapterBin();
  const handles: LaneHandle[] = [];
  const results: LaneStatus[] = [];

  for (const confFile of confFiles) {
    const lane = confFile.replace(/\.conf$/, "");
    const confPath = join(lanesDir, confFile);
    const confText = await readFile(confPath, "utf8");
    const conf = parseLaneConf(confText);

    const paths = lanePaths(baseDir, proj, lane);

    const channel: "telegram" | "obsidian" = conf.source === "obsidian" ? "obsidian" : "telegram";

    let backend: AcpBackend;
    if (opts?.acpFactory) {
      backend = opts.acpFactory(lane, adapterBin);
    } else {
      const impl = new AcpBackendImpl(adapterBin);
      impl.configureLane(lane, {
        paths,
        addePolicy: { perm_tier: conf.perm_tier, allowlist: conf.allowlist },
        cwd: conf.cwd,
        channel,
      });
      backend = impl;
    }

    const pendingDecisions = new Map<string, (decision: "allow" | "deny") => void>();

    const engine = conf.engine || "claude";
    let source: Source;
    if (conf.source === "obsidian") {
      source = createObsidianSource({ lane, proj, engine, paths, conf });
    } else {
      const chatId =
        conf.chat_id && !Number.isNaN(Number(conf.chat_id)) ? Number(conf.chat_id) : undefined;
      source = createTelegramSource({ lane, proj, engine, paths, chatId });
    }

    source.onDecision((reqId, decision) => {
      const resolve = pendingDecisions.get(reqId);
      if (resolve) {
        pendingDecisions.delete(reqId);
        resolve(decision);
      }
    });

    backend.onPermissionRequest(lane, async (req) => {
      const waitForDecision = () =>
        new Promise<"allow" | "deny">((resolveFn) => {
          pendingDecisions.set(req.id, resolveFn);
        });

      const sendPermPrompt = async () => {
        await source.requestPermission(req);
      };

      return gateRequestDecision(req, { sendPermPrompt, waitForDecision });
    });

    const injector = createInjector(paths, lane, backend);

    try {
      await backend.launch(lane);

      void injector.start();
      source.start();

      console.log(`[supervisor] lane=${lane} running`);

      handles.push({
        lane,
        stop() {
          source.stop();
        },
      });

      results.push({ lane, status: "running" });
    } catch (err) {
      console.error(
        `[supervisor] lane=${lane} 기동 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      results.push({ lane, status: "error" });
    }
  }

  const existing = activeLanes.get(proj) ?? [];
  activeLanes.set(proj, [...existing, ...handles]);

  const runningCount = results.filter((r) => r.status === "running").length;
  return {
    lanes: results,
    message: `${proj}: ${runningCount}개 레인 기동`,
  };
}

/**
 * `adde down <proj>` — 프로젝트의 모든 레인 종료.
 */
export async function supervisorDown(
  proj: string,
  _opts?: SupervisorDownOptions,
): Promise<SupervisorDownResult> {
  const handles = activeLanes.get(proj) ?? [];
  const results: LaneStatus[] = [];

  for (const handle of handles) {
    handle.stop();
    console.log(`[supervisor] lane=${handle.lane} stopped`);
    results.push({ lane: handle.lane, status: "stopped" });
  }
  activeLanes.delete(proj);

  return {
    lanes: results,
    message: `${proj}: ${results.length}개 레인 종료`,
  };
}
