/**
 * 내용 주소 blob 저장소(`.adde/blobs/<앞2자>/<sha256>`) — 첨부·대용량 도구 출력의 단일 저장(FR-017).
 * tmp→rename + 존재 시 skip(내용 주소라 재쓰기 무의미). 동시 동일 내용 기록도 결과 동일(무해 경합).
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vaultPaths } from "../shared/paths.js";
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

/** blob 경로(2자 샤딩 디렉터리). */
export function blobPath(vaultRoot: string, proj: string, hex: string): string {
  const { blobsDir } = vaultPaths(vaultRoot, proj);
  return join(blobsDir, hex.slice(0, 2), hex);
}

/** 데이터를 내용 주소로 저장(존재 시 skip) — 참조(`sha256:<hex>`)와 바이트 수를 반환. */
export async function putBlob(ctx: RecordCtx, data: Buffer | string): Promise<BlobRef> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const hex = sha256Hex(buf);
  const dest = blobPath(ctx.vaultRoot, ctx.proj, hex);
  if (!(await exists(dest))) {
    await mkdir(join(dest, ".."), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    await writeFile(tmp, buf);
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
