/**
 * 내용 주소 blob 저장소(`.adde/sessions/<sid>/blobs/<앞2자>/<sha256>`, **세션 소유** — FR-017·FR-026).
 * tmp→rename + 존재 시 skip(내용 주소라 재쓰기 무의미). 동시 동일 내용 기록도 결과 동일(무해 경합).
 * 세션별 분리로 완전 제거는 그 세션 디렉터리 삭제로 완결되고(참조 계산 없음), 대가로 같은 내용을
 * 여러 세션이 각자 보유하면 실체도 그만큼 늘어난다(FR-026 — 선행 요구의 "1회 저장" 은 세션 내로 축소).
 */
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionVaultPaths } from "../shared/paths.js";
import type { BlobRef, RecordCtx } from "./types.js";

/** 도구 출력의 blob 승격 임계 — 이 값을 넘으면 blob 으로, 첨부는 무조건(design.md ADR-019). */
export const BLOB_THRESHOLD_BYTES = 8 * 1024;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** blob 경로(세션 소유, 2자 샤딩 디렉터리). */
export function blobPath(vaultRoot: string, proj: string, sid: string, hex: string): string {
  const { blobsDir } = sessionVaultPaths(vaultRoot, proj, sid);
  return join(blobsDir, hex.slice(0, 2), hex);
}

/** 데이터를 내용 주소로 저장(존재 시 skip) — 참조(`sha256:<hex>`)와 바이트 수를 반환.
 * `ctx.sid` 가 빈 문자열이면 throw(fail-closed) — 프로젝트 스코프 폴백을 구조적으로 금지한다. */
export async function putBlob(ctx: RecordCtx, data: Buffer | string): Promise<BlobRef> {
  if (ctx.sid.length === 0) {
    throw new Error("blobs: putBlob 은 세션 스코프(sid) 가 필요합니다 — 빈 sid 는 거부됩니다.");
  }
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const hex = sha256Hex(buf);
  const dest = blobPath(ctx.vaultRoot, ctx.proj, ctx.sid, hex);
  if (!(await exists(dest))) {
    await mkdir(join(dest, ".."), { recursive: true });
    // 랜덤 접미(보안 검토 SEC-006) — pid 만으로는 다음 tmp 이름을 예측할 수 있어, 공격자가 그
    // 경로에 심볼릭 링크를 미리 심어 두면(선점) 기본 플래그의 `writeFile` 이 그 링크를 따라가
    // 엉뚱한 대상에 쓰게 된다. `flag: "wx"`(O_CREAT|O_EXCL) 로 "이미 있으면 실패" 를 강제해
    // 선점 자체를 무력화한다(`fs-atomic.ts` 의 `atomicWrite`/`reserveNewFile` 과 동일 조치).
    const tmp = `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, buf, { flag: "wx" });
    try {
      await rename(tmp, dest);
    } catch (err) {
      // dest 가 이미 존재하고 내용 해시가 실제로 일치할 때만 동시 저장 경합으로 간주(무해).
      // 그 외(dest 부재·내용 불일치)는 fail-closed — 진짜 쓰기 실패를 경합으로 흡수하지 않는다.
      const raced = (await exists(dest)) && sha256Hex(await readFile(dest)) === hex;
      await unlink(tmp).catch(() => {});
      if (!raced) throw err;
    }
  }
  return { blob: `sha256:${hex}`, bytes: buf.byteLength };
}
