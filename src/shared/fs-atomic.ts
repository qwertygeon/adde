import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * 같은 디렉터리 tmp→rename 으로 원자 기록 — 부분 쓰기가 최종 경로에 노출되지 않는다.
 * tmp 는 숨김(dot-prefix, 에디터/감시 노출 회피) + pid(프로세스 간 tmp 이름 충돌 회피) + `.tmp`
 * 접미(`.msg`/`.out` 등 접미 필터에 걸리지 않음). 대상 디렉터리는 없으면 생성한다.
 * 같은 프로세스에서 동일 filePath 로의 동시 호출은 tmp 가 겹치므로 호출자가 직렬화해야 한다
 * (현 호출처는 모두 직렬 — 큐 상태 전이·markdown op 체인·단발 생성).
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

/**
 * 레인 상태·출력·큐 디렉터리를 권한 모드대로 잠근다.
 * private=0700(소유자 전용 — 다중 사용자 호스트에서 타 로컬 유저의 대화/응답 열람 차단),
 * shared=no-op(기존 기본 권한 유지 — 열람 허용을 옵트인한 경우). 부재 디렉터리는 먼저 생성한다.
 * chmod 실패는 흡수하지 않고 전파한다(권한이 의도대로 적용됐는지는 보안 신호 — 호출부가 로그/판단).
 */
export async function secureLaneDirs(dirs: string[], mode: "private" | "shared"): Promise<void> {
  if (mode !== "private") return;
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
  }
}
