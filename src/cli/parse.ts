/**
 * 통합 CLI 인자 파서 — spec.ts 의 선언(FlagSpec)을 입력으로 argv 를 위치인자/플래그로 분리한다.
 * run/ops/lane/proj 가 공유하는 단일 파싱 경로(SSOT) — 명령별 하드코딩 파싱을 대체한다.
 * 전역 플래그(-h/--help, -v/--version)는 모든 스펙에 암묵 병합되어 위치 무관하게 인식된다.
 * 파서는 순수 함수다 — enum 값 검증·i18n 렌더링을 하지 않고 오류를 {kind, token} 으로만 반환한다
 * (렌더링·usage 출력은 호출측 디스패치가 담당 — 관심사 분리).
 */
import type { ArgKind, FlagSpec } from "./spec.js";

export interface ParseResult {
  positional: string[];
  flags: Record<string, string | true>;
  /** -h/--help 발견. */
  help: boolean;
  /** -v/--version 발견. */
  version: boolean;
  error?: { kind: "unknown-flag" | "value-required"; token: string };
}

const GLOBAL_FLAG_SPECS: readonly FlagSpec[] = [
  { name: "--help", short: "-h" },
  { name: "--version", short: "-v" },
];

/**
 * `-<letter>` 만 단축 플래그 후보로 본다. `-<digit...>`·bare `-` 는 위치인자로 남긴다 —
 * `logs [N]` 위치의 음수 표기(`-5`)가 미지원 플래그로 오인되지 않게 하는 quirk 보존.
 */
function looksLikeShortFlag(tok: string): boolean {
  return /^-[A-Za-z]/.test(tok);
}

/** 값 플래그의 다음 토큰이 플래그로 보이는지(부재 포함) — 값 누락 판정에 쓰인다. */
function looksLikeFlagToken(tok: string | undefined): boolean {
  return tok === undefined || tok.startsWith("--") || looksLikeShortFlag(tok);
}

/**
 * argv 를 위치인자/플래그로 분리한다. spec.flags 에 선언된 플래그(+전역 help/version)만 허용하고,
 * 그 외 `--flag`/미매칭 단축은 error:unknown-flag, 값 플래그의 값 누락은 error:value-required 로
 * 반환한다(순회 중 먼저 만난 오류 1건만 유지 — 다중 오류 수집은 usage 출력이 대신한다).
 */
export function parseCommand(
  spec: { flags: readonly FlagSpec[]; positional?: readonly ArgKind[] },
  argv: readonly string[],
): ParseResult {
  const allFlags = [...GLOBAL_FLAG_SPECS, ...spec.flags];
  const byLong = new Map(allFlags.map((f) => [f.name, f] as const));
  const byShort = new Map(
    allFlags
      .filter((f): f is FlagSpec & { short: string } => f.short !== undefined)
      .map((f) => [f.short, f] as const),
  );

  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let help = false;
  let version = false;
  let error: ParseResult["error"];

  const apply = (f: FlagSpec, value: string | true): void => {
    if (f.name === "--help") help = true;
    else if (f.name === "--version") version = true;
    else flags[f.name.slice(2)] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok : tok.slice(0, eq);
      const f = byLong.get(name);
      if (!f) {
        error ??= { kind: "unknown-flag", token: name };
        continue;
      }
      if (eq !== -1) {
        if (!f.takesValue) {
          error ??= { kind: "unknown-flag", token: name };
          continue;
        }
        apply(f, tok.slice(eq + 1));
        continue;
      }
      if (f.takesValue) {
        const next = argv[i + 1];
        if (looksLikeFlagToken(next)) {
          error ??= { kind: "value-required", token: name };
          continue;
        }
        apply(f, next as string);
        i++;
      } else {
        apply(f, true);
      }
    } else if (looksLikeShortFlag(tok)) {
      const f = byShort.get(tok);
      if (!f) {
        error ??= { kind: "unknown-flag", token: tok };
        continue;
      }
      apply(f, true);
    } else {
      positional.push(tok);
    }
  }

  return { positional, flags, help, version, ...(error ? { error } : {}) };
}
