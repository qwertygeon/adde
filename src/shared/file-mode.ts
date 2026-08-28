/**
 * `file_mode` 적용 — 설정 루트의 내부 디렉터리(프로젝트 루트·세션 레코드·런타임 트리)를 선언한
 * 권한으로 잠근다. 적용 범위는 사용자 대면 문구가 약속한 범위와 같다(내부 state·queue) — 저장소
 * (vault) 노트 트리는 사용자 문서이므로 대상이 아니다.
 *
 * 적용 지점은 두 곳이다: 프로젝트 생성 시점과 데몬 기동 시점. 생성 시점만 적용하면 이후 만들어진
 * 디렉터리나 다른 머신에서 복제된 설정이 잠기지 않고, 기동 시점만 적용하면 데몬을 띄우기 전 구간이
 * 비어 있다. `private` 가 아니면 아무것도 하지 않는다 — 완화(private→shared)는 수동 chmod 소관이다.
 */
import { securePrivateDirs } from "./fs-atomic.js";
import { projectPaths } from "./paths.js";

export type FileMode = "private" | "shared";

/** conf 의 `file_mode` 문자열을 해석한다. 미지정·미지값은 기본값 `private`(잠금 우선). */
export function resolveFileMode(raw: string | undefined): FileMode {
  return raw === "shared" ? "shared" : "private";
}

/** 프로젝트의 설정 루트 내부 디렉터리에 권한 모드를 적용한다. */
export async function applyProjectFileMode(
  base: string,
  proj: string,
  rawMode: string | undefined,
): Promise<void> {
  const pp = projectPaths(base, proj);
  await securePrivateDirs([pp.root, pp.sessionsDir, pp.runtimeDir], resolveFileMode(rawMode));
}
