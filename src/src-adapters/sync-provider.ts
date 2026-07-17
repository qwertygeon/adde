/**
 * 동기화 제공자 확장점 — vault 가 놓인 동기화 서비스별 이관 전 물질화(materialize) 전략.
 * SOURCE_REGISTRY(index.ts) 의 데이터 주도 디스패치 패턴을 차용 — 신규 제공자는 레지스트리
 * 등록만으로 추가되며 safeMove·resolveSyncProvider 호출부는 코드 변경이 필요 없다.
 */
import { open, stat } from "node:fs/promises";

export type SyncMaterialize = "ready" | "skip";

export interface SyncProviderDescriptor {
  id: string;
  /**
   * 이동 전 파일을 로컬에 물질화(materialize) 보장. dataless(placeholder)면 다운로드 트리거 +
   * 유계 대기 후 재검증 → "ready"|"skip". 지연·실패 시 "skip"(fail-open, 다음 실행 재시도).
   * local 은 dataless 개념이 없어 항상 "ready".
   */
  ensureLocal(path: string): Promise<SyncMaterialize>;
}

const localProvider: SyncProviderDescriptor = {
  id: "local",
  async ensureLocal(): Promise<SyncMaterialize> {
    return "ready";
  },
};

/** iCloud dataless 유계 대기 상한(ms) — 다운로드 완료를 기다리는 최대 시간. */
const ICLOUD_DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * macOS iCloud dataless(placeholder) 감지 — 실기기 실측 검증 완료(evict 직후 정확히 이 상태).
 * `stat` 의 `blocks`(할당된 512바이트 블록 수)가 0인데 `size`(논리 크기)가 0보다 크면 콘텐츠가
 * 로컬에 없는 placeholder 로 간주한다(일반 파일은 콘텐츠만큼 블록을 점유). 감지 실패(예외·플랫폼
 * 미지원)는 보수적으로 "이미 로컬"(false)로 간주해 불필요한 대기를 만들지 않는다 — 이때 stat 이
 * 실패한 파일은 하류 rename/copy 도 같은 이유로 실패해 건별 오류로 표면화된다(무손실). 단
 * same-volume rename 이관은 copy-후-크기검증(fs-move.ts)을 타지 않으므로, dataless 미탐 시의
 * 방어선은 본 물질화가 단독이다(하류 크기검증은 EXDEV copy 폴백 한정).
 */
async function isDataless(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.blocks === 0 && s.size > 0;
  } catch {
    return false;
  }
}

const icloudProvider: SyncProviderDescriptor = {
  id: "icloud",
  async ensureLocal(path: string): Promise<SyncMaterialize> {
    if (!(await isDataless(path))) return "ready";
    // 다운로드 트리거 — 1바이트 콘텐츠 read. FileProvider 는 stat 으로는 다운로드를 시작하지
    // 않고 콘텐츠 read 가 물질화 완료까지 블록한다(실기기 실측 — 018 analysis.md 사전 조사).
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(path, "r");
    } catch {
      // open 실패는 보조 신호 — 아래 isDataless 재검증이 최종 판정한다(skip 수렴).
    }
    if (fh) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), ICLOUD_DOWNLOAD_TIMEOUT_MS);
      });
      // read 완료 = 물질화 완료(블록형 트리거). reject 도 settle 로 수렴시켜 unhandled
      // rejection 을 차단한다(전역 TS 규칙 §비동기 수명 안전).
      const read = fh.read(Buffer.alloc(1), 0, 1, 0).then(
        () => "read" as const,
        () => "read" as const,
      );
      await Promise.race([read, timeout]);
      clearTimeout(timer);
      // 승자 무관 close — 타임아웃 승리 시 close 가 대기 중 read 를 해제해 fd 를 유계화한다
      // (다운로드가 영구히 안 끝나는 조건에서 fd 누적·EMFILE 방지). 이번 실행은 skip 으로
      // 끝나도 다음 일간 실행이 재시도한다(fail-open 재시도 모델).
      await fh.close().catch(() => {});
    }
    return (await isDataless(path)) ? "skip" : "ready";
  },
};

/** id → 제공자 정의. 새 제공자 추가 = 여기 등록만(기존 항목 코드 변경 없음). */
export const SYNC_PROVIDER_REGISTRY: Record<string, SyncProviderDescriptor> = {
  local: localProvider,
  icloud: icloudProvider,
};

/** 등록된 제공자 id 목록(등록 순서 = local 우선). */
export const SYNC_PROVIDER_IDS: readonly string[] = Object.keys(SYNC_PROVIDER_REGISTRY);

/** 미등록 sync_provider 값 — 호출부(기동 검증)가 catch 해 지역화된 거부 사유로 재포장한다. */
export class UnsupportedSyncProviderError extends Error {
  constructor(public readonly value: string) {
    super(`unsupported sync provider: ${value}`);
    this.name = "UnsupportedSyncProviderError";
  }
}

/**
 * sync_provider 설정값 → descriptor 해석. 미지정 시 "local". 미등록 값은
 * UnsupportedSyncProviderError throw(fail-closed) — 호출부가 기동 거부·사유 표기로 전환한다.
 */
export function resolveSyncProvider(id: string | undefined): SyncProviderDescriptor {
  const resolved = id ?? "local";
  const descriptor = SYNC_PROVIDER_REGISTRY[resolved];
  if (!descriptor) throw new UnsupportedSyncProviderError(resolved);
  return descriptor;
}
