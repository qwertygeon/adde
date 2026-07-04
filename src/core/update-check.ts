/**
 * 업데이트 알림 — npm 레지스트리의 최신 배포판을 현재 버전과 비교해 안내 문구를 만든다.
 * 결과는 base 아래 .update-check.json 에 캐시(기본 24h)해 매 호출 네트워크를 피한다.
 * 보조 기능이므로 모든 실패(오프라인·타임아웃·파싱)를 흡수한다 — 조회 실패로 CLI 를 막지 않는다.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { defaultBase } from "../shared/paths.js";
import { readVersion } from "./version.js";
import { t } from "../shared/i18n.js";

/** dist-tag latest 를 직접 반환하는 레지스트리 엔드포인트. */
const REGISTRY_URL = "https://registry.npmjs.org/adde/latest";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const CACHE_FILE = ".update-check.json";

export interface UpdateCheckOptions {
  base?: string;
  currentVersion?: string;
  /** 네트워크 조회 허용(대화형에서만 true 권장). false 면 캐시만 사용해 지연 0. */
  allowNetwork?: boolean;
  now?: number;
  ttlMs?: number;
  /** 테스트 주입용 fetch. 미지정 시 global fetch. */
  fetchImpl?: typeof fetch;
  /** 환경 opt-out(테스트 주입). 미지정 시 process.env.ADDE_NO_UPDATE_CHECK. */
  optOut?: string | undefined;
}

interface CacheShape {
  checkedAt: number;
  latest: string;
}

/** "1.2.3" → [1,2,3]. 숫자 파트만 비교(프리릴리스 무시 — latest dist-tag 는 안정판). */
interface Semver {
  core: number[];
  /** 프리릴리스 식별자(예: rc.1 → ["rc","1"]). 없으면 빈 배열(= 정식 릴리스, 프리릴리스보다 높음). */
  pre: string[];
}

function parseSemver(v: string): Semver | null {
  const noBuild = v.trim().replace(/^v/, "").split("+")[0] ?? "";
  const dash = noBuild.indexOf("-");
  const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preStr = dash === -1 ? "" : noBuild.slice(dash + 1);
  const core = coreStr.split(".").map((n) => Number(n));
  if (core.length === 0 || core.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { core, pre: preStr === "" ? [] : preStr.split(".") };
}

/** 프리릴리스 식별자 비교(semver): 숫자<영숫자, 숫자끼리 수치비교, 그 외 사전순, 더 짧은 쪽이 낮음. */
function comparePre(a: string[], b: string[]): number {
  // 프리릴리스 없음(정식) > 프리릴리스 있음. 둘 다 없으면 동등.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // 더 짧은 쪽이 낮음
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 순수 숫자 식별자는 영숫자보다 낮은 우선순위
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** a<b → -1, a>b → 1, 같음/비교불가 → 0. 프리릴리스는 동일 core 의 정식 릴리스보다 낮다. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

async function readCache(path: string): Promise<CacheShape | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheShape>;
    if (typeof parsed.checkedAt === "number" && typeof parsed.latest === "string") {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // 캐시 부재·파싱 실패 — 조회로 진행(보조).
  }
  return null;
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateNotice {
  current: string;
  latest: string;
}

/**
 * 업데이트 여부 판정 — 새 버전이 있으면 {current, latest}, 없으면 null.
 * 캐시가 신선하면 캐시만 사용, 오래됐고 allowNetwork 면 레지스트리 조회 후 캐시 갱신.
 */
export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateNotice | null> {
  const optOut = opts.optOut ?? process.env["ADDE_NO_UPDATE_CHECK"];
  if (optOut) return null;
  const base = opts.base ?? defaultBase();
  const current = opts.currentVersion ?? readVersion();
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = join(base, CACHE_FILE);

  let latest: string | null = null;
  const cache = await readCache(cachePath);
  if (cache && now - cache.checkedAt < ttlMs) {
    latest = cache.latest;
  } else if (opts.allowNetwork) {
    latest = await fetchLatest(opts.fetchImpl ?? fetch);
    if (latest) {
      await atomicWrite(cachePath, JSON.stringify({ checkedAt: now, latest })).catch(() => {});
    }
  } else if (cache) {
    // 네트워크 비허용(비대화형)이라도 오래된 캐시값으로 안내는 가능.
    latest = cache.latest;
  }
  if (!latest) return null;
  return compareSemver(current, latest) < 0 ? { current, latest } : null;
}

/** 업데이트 안내 문구. 표면 계층이 stdout 에 덧붙인다. */
export function formatUpdateNotice(notice: UpdateNotice): string {
  return t("update.available", { current: notice.current, latest: notice.latest });
}
