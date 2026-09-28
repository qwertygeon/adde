/**
 * sha256·UTF-8 인코딩 — 도메인에서 `node:crypto` 를 import 하는 유일한 파일(NFR-001, SC-045).
 */
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return new Uint8Array(hash.digest());
}
