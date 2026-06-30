import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 루트 VERSION 파일을 버전 SoT 로 읽는다(design/08 §5, infra.md).
 * 모듈 위치에서 상위로 올라가며 VERSION 을 탐색하므로 src(tsx) · dist 양쪽에서 동작한다.
 * 버전 표시는 보조 기능이므로 미발견 시 "unknown" 으로 흡수한다(에러 전파 대상 아님).
 */
export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "VERSION");
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8").trim();
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}
