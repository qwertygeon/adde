import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * package.json 의 version 을 버전 SoT 로 읽는다.
 * 모듈 위치에서 상위로 올라가며 package.json 을 탐색하므로 src(tsx) · dist · 전역 설치 모두에서 동작한다
 * (npm 은 package.json 을 항상 패키지에 포함하므로 설치본에서도 확실히 존재).
 * 버전 표시는 보조 기능이므로 미발견·파싱 실패 시 "unknown" 으로 흡수한다(에러 전파 대상 아님).
 */
export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const version = JSON.parse(readFileSync(candidate, "utf8")).version;
        if (typeof version === "string" && version.length > 0) return version;
      } catch {
        // 파싱 실패는 흡수 — 보조 기능이므로 unknown 으로 폴백
      }
      return "unknown";
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}
