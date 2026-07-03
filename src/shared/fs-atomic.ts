import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * 같은 디렉터리 tmp→rename 으로 원자 기록 — 부분 쓰기가 최종 경로에 노출되지 않는다.
 * tmp 는 숨김(dot-prefix, 에디터/감시 노출 회피) + pid(동시 쓰기 충돌 회피) + `.tmp` 접미
 * (`.msg`/`.out` 등 접미 필터에 걸리지 않음). 대상 디렉터리는 없으면 생성한다.
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.tmp`);
  await writeFile(
    tmp,
    content,
    opts?.mode === undefined ? "utf8" : { encoding: "utf8", mode: opts.mode },
  );
  await rename(tmp, filePath);
}
