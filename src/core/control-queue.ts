/**
 * CLI↔데몬 control 큐(신규, L3) — 라이브니스 기록(runtime.json 하트비트)에 의존하지 않고 **관측된
 * 흡수 사실**로 판정한다. 채널은 설정 루트 `runtime/control/`(vault 가 아니라 동기화 대상
 * 밖 — silent failure 회피). CLI 는 요청을 쓰고 유계 대기 후 결과를 관측하거나(acked), 아무도 claim
 * 하지 않았음을 관측해 직접 적용하거나(unclaimed), claim 됐으나 결과를 확인할 수 없어 거부한다
 * (unconfirmed — 무동작 성공 보고 금지, FR-022).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode, errMsg } from "../shared/errors.js";
import { isPidAlive } from "./runtime-state.js";
import { projectPaths } from "../shared/paths.js";
import type { ProjectPaths } from "../shared/paths.js";

/** 데몬 측 드레인 주기(ms). */
export const CONTROL_DRAIN_INTERVAL_MS = 2_000;
/** CLI 가 결과를 기다리는 1차 유계 대기(ms, 100ms 폴). */
export const CONTROL_ACK_TIMEOUT_MS = 6_000;
/** claim 됐으나 결과 미확인 시 추가로 주는 유예(ms). */
export const CONTROL_CLAIMED_GRACE_MS = 2_000;
/** 고아 `.res.json` 정리 임계(ms) — claim 필요 없이 파일명(id)의 타임스탬프 접두로 판정. */
const ORPHAN_RES_MAX_AGE_MS = 60 * 60 * 1000;

export type ControlOp = "stop" | "resume" | "remove";
const CONTROL_OPS = new Set<ControlOp>(["stop", "resume", "remove"]);

export interface ControlRequest {
  v: 1;
  id: string;
  op: ControlOp;
  sid: string;
  requestedAt: string;
  requester: { pid: number };
}

/**
 * claim 파일 최소 스키마 검증(보안 검토 SEC-002) — `JSON.parse(...) as ControlRequest` 는 컴파일
 * 타임 단언일 뿐 런타임 보장이 아니다. `op` 가 미인식 값이면 소비처(`handleControlRequest`)의
 * 폴백이 가장 파괴적인 `remove` 로 향하던 결함(A-P006 위반)이 있었다 — 여기서 열거값·타입을
 * 확인해 미인식 요청을 소비처에 아예 도달시키지 않는다(fail-closed). `v` 는 프로토콜 버전
 * 확인용으로 신설 이전엔 아무도 읽지 않았다.
 */
function isValidControlRequest(x: unknown): x is ControlRequest {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r["v"] !== 1) return false;
  if (typeof r["id"] !== "string" || r["id"].length === 0) return false;
  if (typeof r["op"] !== "string" || !CONTROL_OPS.has(r["op"] as ControlOp)) return false;
  if (typeof r["sid"] !== "string") return false;
  if (typeof r["requestedAt"] !== "string") return false;
  const requester = r["requester"];
  if (typeof requester !== "object" || requester === null) return false;
  if (typeof (requester as Record<string, unknown>)["pid"] !== "number") return false;
  return true;
}

export interface ControlResult {
  v: 1;
  id: string;
  ok: boolean;
  result?: string;
  reason?: string;
}

interface DaemonMarker {
  v: 1;
  pid: number;
  bootedAt: string;
}

function reqFileName(id: string): string {
  return `${id}.req.json`;
}
function claimFileName(id: string): string {
  return `${id}.claim.json`;
}
function resFileName(id: string): string {
  return `${id}.res.json`;
}
function reclaimFileName(id: string): string {
  return `${id}.reclaim.json`;
}

function idFromSuffix(filename: string, suffix: string): string {
  return filename.slice(0, -suffix.length);
}

async function waitForResult(resPath: string, timeoutMs: number): Promise<ControlResult | null> {
  const start = Date.now();
  for (;;) {
    try {
      const raw = await readFile(resPath, "utf8");
      return JSON.parse(raw) as ControlResult;
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * CLI 측 — 요청을 쓰고 데몬 흡수를 관측된 사실로 판정한다(§4 프로토콜).
 * `kind:"unclaimed"` 는 아무도 claim 하지 않았음이 회수(rename) 성공으로 확인된 경우이며,
 * 호출자(CLI 핸들러)가 그때 **직접 적용**할 책임을 진다(무동작 성공 보고 금지).
 */
export async function submitControl(a: {
  base: string;
  proj: string;
  op: ControlOp;
  sid: string;
}): Promise<
  { kind: "acked"; result: ControlResult } | { kind: "unclaimed" } | { kind: "unconfirmed" }
> {
  const pp = projectPaths(a.base, a.proj);
  await mkdir(pp.controlDir, { recursive: true });
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const req: ControlRequest = {
    v: 1,
    id,
    op: a.op,
    sid: a.sid,
    requestedAt: new Date().toISOString(),
    requester: { pid: process.pid },
  };
  const reqPath = join(pp.controlDir, reqFileName(id));
  const resPath = join(pp.controlDir, resFileName(id));
  await atomicWrite(reqPath, JSON.stringify(req));

  // 지연 최적화 — 데몬 마커 부재/pid 사망이면 6초 대기를 건너뛰고 곧바로 회수를 시도한다.
  // 정합성은 이 최적화가 아니라 claim/ack 관측 + rev CAS 가 보장한다.
  const markerAlive = await daemonMarkerAlive(pp);
  const acked = await waitForResult(resPath, markerAlive ? CONTROL_ACK_TIMEOUT_MS : 0);
  if (acked) {
    await unlink(resPath).catch(() => {});
    return { kind: "acked", result: acked };
  }

  // 회수 시도 — rename 성공 = 아무도 claim 하지 않았다는 관측 사실(POSIX rename 원자적 배타).
  const reclaimPath = join(pp.controlDir, reclaimFileName(id));
  try {
    await rename(reqPath, reclaimPath);
    await unlink(reclaimPath).catch(() => {});
    return { kind: "unclaimed" };
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    // ENOENT = 이미 누군가(데몬) claim 했다 — 추가 유예 후 결과를 한 번 더 관측한다.
    const late = await waitForResult(resPath, CONTROL_CLAIMED_GRACE_MS);
    if (late) {
      await unlink(resPath).catch(() => {});
      return { kind: "acked", result: late };
    }
    return { kind: "unconfirmed" };
  }
}

/** `.res.json` 중 id 타임스탬프 접두가 임계를 넘은 고아 파일을 정리한다(유계 janitor). */
async function sweepOrphanResults(controlDir: string, files: readonly string[]): Promise<void> {
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith(".res.json")) continue;
    const id = idFromSuffix(f, ".res.json");
    const ts = Number.parseInt(id.split("-")[0] ?? "", 10);
    if (Number.isFinite(ts) && now - ts > ORPHAN_RES_MAX_AGE_MS) {
      await unlink(join(controlDir, f)).catch(() => {});
    }
  }
}

/**
 * 데몬 측 — 대기 중인 요청을 claim(원자적 배타 rename) → 처리 → 결과 write(먼저) → claim unlink.
 * `handle` 이 던지면 결과를 `ok:false` 로 기록해 CLI 에 사유를 전달한다(무응답보다 명시 실패가 낫다).
 * 반환값은 이번 호출에서 처리한 요청 수(빈 큐는 0).
 */
export async function drainControl(a: {
  base: string;
  proj: string;
  handle: (req: ControlRequest) => Promise<ControlResult>;
}): Promise<number> {
  const pp = projectPaths(a.base, a.proj);
  let files: string[];
  try {
    files = await readdir(pp.controlDir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return 0;
    throw err;
  }
  const reqFiles = files.filter((f) => f.endsWith(".req.json")).sort();
  let handled = 0;
  for (const f of reqFiles) {
    const id = idFromSuffix(f, ".req.json");
    const reqPath = join(pp.controlDir, f);
    const claimPath = join(pp.controlDir, claimFileName(id));
    try {
      await rename(reqPath, claimPath);
    } catch (err) {
      if (errCode(err) === "ENOENT") continue; // 다른 소유자(이론상 데몬 1개뿐이나 방어적) — 다음 후보.
      throw err;
    }
    let req: ControlRequest;
    try {
      const parsed: unknown = JSON.parse(await readFile(claimPath, "utf8"));
      if (!isValidControlRequest(parsed)) {
        // 파싱은 됐으나 스키마 위반(미인식 op·v 불일치 등) — 손상 JSON(아래 catch)과 달리
        // 명시 거부 결과를 남긴다(CLI 가 무응답 타임아웃 대신 사유를 즉시 관측하도록, A-P006).
        console.error(`control-queue: 스키마 위반 요청 거부 (${id})`);
        await atomicWrite(
          join(pp.controlDir, resFileName(id)),
          JSON.stringify({
            v: 1,
            id,
            ok: false,
            reason: "스키마 위반 — 처리할 수 없는 요청입니다.",
          }),
        );
        await unlink(claimPath).catch(() => {});
        continue;
      }
      req = parsed;
    } catch (err) {
      console.error(`control-queue: 손상 요청 무시 (${id}): ${errMsg(err)}`);
      await unlink(claimPath).catch(() => {});
      continue;
    }
    let result: ControlResult;
    try {
      result = await a.handle(req);
    } catch (err) {
      result = { v: 1, id, ok: false, reason: errMsg(err) };
    }
    // 완료 마킹(.res)을 먼저 쓴다 — claim 파일 잔존은 "진행 중" 을 뜻하고 CLI 는 .res 만 성공 근거로 삼는다.
    await atomicWrite(join(pp.controlDir, resFileName(id)), JSON.stringify(result));
    await unlink(claimPath).catch(() => {});
    handled += 1;
  }
  await sweepOrphanResults(pp.controlDir, files);
  return handled;
}

/** 데몬 존재 마커 write(부팅 시) — 지연 최적화 전용(정합성은 claim/ack + rev CAS 가 보장). */
export async function writeDaemonMarker(paths: ProjectPaths): Promise<void> {
  const marker: DaemonMarker = { v: 1, pid: process.pid, bootedAt: new Date().toISOString() };
  await mkdir(paths.controlDir, { recursive: true });
  await atomicWrite(join(paths.controlDir, "daemon.json"), JSON.stringify(marker));
}

/** 데몬 존재 마커 제거(graceful shutdown) — 크래시로 잔존해도 정합성에 영향 없다(pid 생존 확인이 보완). */
export async function clearDaemonMarker(paths: ProjectPaths): Promise<void> {
  await unlink(join(paths.controlDir, "daemon.json")).catch(() => {});
}

/** 데몬 마커가 존재하고 그 pid 가 생존해 있는가(지연 최적화 판정 전용). */
export async function daemonMarkerAlive(paths: ProjectPaths): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(paths.controlDir, "daemon.json"), "utf8");
  } catch {
    return false;
  }
  let marker: DaemonMarker;
  try {
    marker = JSON.parse(raw) as DaemonMarker;
  } catch {
    return false;
  }
  return typeof marker.pid === "number" && isPidAlive(marker.pid);
}
