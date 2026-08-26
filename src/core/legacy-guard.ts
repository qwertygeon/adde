/**
 * v0.2.x 레이아웃 탐지·이름 충돌 가드(FR-032·NFR-001, ADR-003) — **stat 만** 수행(파일 내용은
 * 읽지 않는다), 구 데이터는 절대 변경하지 않는다. 부팅 시퀀스 3단계·`project add`/`doctor` 가 소비.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface LegacyProjectInfo {
  proj: string;
  path: string;
}

/** v0.2.x 프로젝트 디렉터리(레인 conf 를 담은 `lanes.d/` 보유) 탐지. */
export async function detectLegacyLayout(base: string): Promise<LegacyProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const found: LegacyProjectInfo[] = [];
  for (const name of entries) {
    if (name === "projects") continue; // v2 컨테이너 디렉터리 자체는 대상 아님
    const dirPath = join(base, name);
    try {
      const st = await stat(dirPath);
      if (!st.isDirectory()) continue;
      const lanesD = await stat(join(dirPath, "lanes.d"));
      if (lanesD.isDirectory()) found.push({ proj: name, path: dirPath });
    } catch {
      // stat 실패(부재 등) — 대상 아님(무음 — 존재 판정 실패는 "없음"과 동치)
    }
  }
  return found;
}

/**
 * `projects` 이름 충돌 판정(ADR-003) — v0.2.x 프로젝트 이름이 "projects" 였던 경우 v2 가 그 이름을
 * 컨테이너로 예약하는 것과 충돌한다. 충돌 사유 문자열(없으면 null).
 */
export async function detectProjectsNameCollision(base: string): Promise<string | null> {
  const collidingPath = join(base, "projects", "lanes.d");
  try {
    const st = await stat(collidingPath);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  return (
    `"${join(base, "projects")}" 가 v0.2.x 프로젝트(lanes.d/ 보유)와 이름이 충돌합니다 — ` +
    `v2 는 이 이름을 프로젝트 컨테이너로 예약합니다. 구 데이터는 변경하지 않았습니다.`
  );
}
