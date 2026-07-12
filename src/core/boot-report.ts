/**
 * 데몬 부팅 리포트 — supervisorUp 완료 시 레인별 최종 기동 상태를 단조 boot id 와 함께 기록한다.
 * 데몬 프로세스 단일 writer, CLI 프로세스 reader(runtime.json 과 동일한 파일시스템 교차프로세스
 * 신호 패턴). up/restart 는 boot id 비교(strict-greater)만으로 자신이 개시한 부팅을 판정한다
 * (시각 비교·stale 추론 미사용).
 */
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { maskSecrets } from "../shared/mask.js";
import { daemonBootReportPath } from "../shared/paths.js";
import type { LaneStatus } from "./supervisor.js";

export interface BootReportLane {
  lane: string;
  status: "running" | "error";
  /** status==="error" 일 때만 존재. maskSecrets 적용된 사유. */
  error?: string;
}

export interface BootReport {
  /** 스키마 버전(전방호환). */
  v: 1;
  /** 단조 증가 정수(직전 리포트 bootId + 1) — 판정은 이 값의 비교로만 이뤄진다(시각 아님). */
  bootId: number;
  /** ISO8601 — 정보용(진단 표시). 판정에 사용 금지. */
  bootedAt: string;
  lanes: BootReportLane[];
  /** status==="running" 레인 수. */
  running: number;
}

/**
 * 현재 부팅 리포트를 읽는다. 파일 부재(ENOENT)·파싱 실패·스키마 불일치(`v!==1`)만 `null`
 * (이 판독에 한정된 fail-safe — 손상 리포트가 baseline=0 처리로 이어져도 다음 부팅이
 * bootId=1 을 발급하므로 정상 판정을 막지 않는다). 그 외 fs 오류(EMFILE/EACCES 등 일시·환경
 * 오류)는 부재와 의미가 다르므로 흡수하지 않고 전파한다 — null 로 뭉개면 CLI baseline 이 0 이
 * 되어 잔존 리포트를 이번 부팅 결과로 오소비(fail-open)하거나, 데몬 prev 판독 실패가 bootId 를
 * 1 로 리셋해 건강한 부팅을 거짓 크래시로 보고할 수 있다.
 */
export async function readBootReport(base: string, proj: string): Promise<BootReport | null> {
  const path = daemonBootReportPath(base, proj);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1
    ) {
      return null;
    }
    return parsed as BootReport;
  } catch {
    return null;
  }
}

/**
 * supervisorUp 결과로 리포트를 기록한다. bootId 는 직전 리포트+1 로 데몬이 자체 발급한다
 * (launchd 가 고정 인자로 데몬을 spawn 하므로 CLI 가 id 를 주입할 채널이 없다).
 * 반환값 = 기록한 bootId(데몬 로그용).
 */
export async function writeBootReport(
  base: string,
  proj: string,
  lanes: LaneStatus[],
  now?: () => number,
): Promise<number> {
  const prev = await readBootReport(base, proj);
  const bootId = (prev?.bootId ?? 0) + 1;
  const reportLanes: BootReportLane[] = lanes.map((l) => {
    if (l.status === "error") {
      return { lane: l.lane, status: "error", error: maskSecrets(l.error ?? "") };
    }
    return { lane: l.lane, status: l.status === "running" ? "running" : "error" };
  });
  const report: BootReport = {
    v: 1,
    bootId,
    bootedAt: new Date(now?.() ?? Date.now()).toISOString(),
    lanes: reportLanes,
    running: reportLanes.filter((l) => l.status === "running").length,
  };
  await atomicWrite(daemonBootReportPath(base, proj), JSON.stringify(report));
  return bootId;
}
