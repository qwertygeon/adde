/**
 * 로그 라이브 tail 코어(`adde logs --follow/-f`) — 읽기 전용, CLI 비의존(A-P007).
 * fs.watch(상위 디렉터리) 이벤트를 1차 트리거로, 저빈도 stat 폴링을 안전망으로 상시 병행하는
 * 하이브리드 방식으로 세대 회전(rename)·truncate·재성장을 추적한다(tail -F 시맨틱).
 * 무손실 보장 범위는 마지막 관측 시점까지다(초고속 연쇄 회전의 이론적 한계는 GAP-002 참조).
 */
import { stat as fsStat, open } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { dirname, basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** 안전망 폴링 기본 주기(ms) — fs.watch 가 미지원·이벤트 유실·회전 무효화 상황에서도 신규 라인
 * 추적이 조용히 멈추지 않도록 하는 최종 보루 주기. fs.watch 가 1차 트리거이므로 저빈도로 충분하다 —
 * 폴은 stat 만 수행(무변 시 read 안 함)해 busy-poll 이 아니다. */
const SAFETY_NET_POLL_MS = 1000;

/** stat/read/watch 주입 포인트 — 미지정 시 Node 기본 구현(단위 테스트는 결정적 시퀀스·이벤트를 주입). */
export interface FollowDeps {
  /** 경로의 inode·size 조회. 부재(회전 순간 등)면 null. */
  stat?: (p: string) => Promise<{ ino: number; size: number } | null>;
  /** offset..offset+length 바이트 범위를 Buffer 로 읽는다(디코드는 코어가 StringDecoder 로 소유). */
  read?: (p: string, offset: number, length: number) => Promise<Buffer>;
  /** 상위 디렉터리 변경 알림 주입점. eventType 은 플랫폼 간 신뢰 불가하므로 관측 트리거로만 쓴다.
   * onError(선택)는 감시 자체의 오류(감시 디렉터리 소실 등) 통지 — 기본 구현은 통지 후 감시를 내린다. */
  watch?: (
    path: string,
    listener: (eventType: string, filename: string | null) => void,
    onError?: (err: unknown) => void,
  ) => { close(): void };
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface FollowOptions {
  /** 신규 라인 청크 sink(호출측이 stdout 등에 쓴다). */
  onData: (chunk: string) => void;
  /** abort 시 즉시 정지(SIGINT 등). */
  signal: AbortSignal;
  /** 안전망 폴링 주기 ms(기본 SAFETY_NET_POLL_MS) — fs.watch 는 1차 트리거이고 이 값은 최종 보루 주기. */
  pollMs?: number;
  /** 변경 감시 자체가 오류로 끊겼을 때 1회 통지(선택) — 추적은 안전망 폴링으로 계속된다. */
  onWatchError?: (err: unknown) => void;
  deps?: FollowDeps;
  /** 초기 스냅샷 이후 이어읽기 시작 오프셋(호출 시점 파일 끝). */
  startOffset: number;
  /** 시작 시 inode(회전 감지 기준점). */
  startIno: number;
}

const defaultStat: NonNullable<FollowDeps["stat"]> = async (p) => {
  try {
    const st = await fsStat(p);
    return { ino: st.ino, size: st.size };
  } catch {
    return null;
  }
};

const defaultRead: NonNullable<FollowDeps["read"]> = async (p, offset, length) => {
  if (length <= 0) return Buffer.alloc(0);
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

const defaultWatch: NonNullable<FollowDeps["watch"]> = (path, listener, onError) => {
  const watcher = fsWatch(path, (eventType, filename) => listener(eventType, filename));
  // watcher 오류(감시 디렉터리 소실 등)는 크래시 사유가 아니다 — error 리스너 부재 시
  // EventEmitter 가 throw 하므로 여기서 통지(보조 실패 = 로그 후 흡수는 호출측 몫) 후
  // 감시만 내린다. 추적은 상시 병행 중인 안전망 stat 폴링이 이어간다(조용한 멈춤 없음).
  watcher.on("error", (err) => {
    onError?.(err);
    watcher.close();
  });
  return watcher;
};

/**
 * 대상 파일을 fs.watch(상위 디렉터리) + 저빈도 stat 폴링(안전망)으로 추적하며 신규 라인을
 * `onData` 로 방출한다. `signal` abort 시 즉시 정지하고 resolve(잔여 관측은 시작조차 하지 않는다).
 * 매 관측(observe): stat/read 실패(세대 회전·삭제 경합 등)는 이 관측만 skip 하고 다음 관측에서
 * 회전 분기로 수렴 / inode 변경→회전(새 파일 0..size 읽기 + decoder 리셋 + curIno/offset 갱신) /
 * size<offset→truncate(offset 0 재조정 후 0..size 읽기 + decoder 리셋) / size>offset→append(offset..size
 * 증분 읽기, decoder 이월) / 그 외 무변화. 읽은 Buffer 는 StringDecoder 로 디코드해 완전한 문자만
 * 방출하고 경계에 걸친 잔여 바이트는 decoder 가 다음 관측까지 버퍼링한다.
 */
export function followFile(target: string, opts: FollowOptions): Promise<void> {
  const stat = opts.deps?.stat ?? defaultStat;
  const read = opts.deps?.read ?? defaultRead;
  const watch = opts.deps?.watch ?? defaultWatch;
  const setIntervalFn = opts.deps?.setInterval ?? setInterval;
  const clearIntervalFn = opts.deps?.clearInterval ?? clearInterval;
  const pollMs = opts.pollMs ?? SAFETY_NET_POLL_MS;
  const targetName = basename(target);

  return new Promise((resolve) => {
    let curIno = opts.startIno;
    let offset = opts.startOffset;
    let decoder = new StringDecoder("utf8");
    // 겹쳐 실행 방지 가드(느린 read 등으로 이전 관측이 아직 진행 중일 때).
    let observing = false;
    // 관측 진행 중 도착한 트리거 — 완료 후 1회 더 관측해 코얼레싱으로 놓친 최종 상태를 보정한다.
    let pending = false;
    let stopped = false;

    if (opts.signal.aborted) {
      resolve();
      return;
    }

    const observe = async (): Promise<void> => {
      if (stopped) return;
      if (observing) {
        pending = true;
        return;
      }
      observing = true;
      try {
        const st = await stat(target).catch(() => null);
        if (st === null) return;
        if (st.ino !== curIno) {
          const buf = await read(target, 0, st.size);
          decoder = new StringDecoder("utf8");
          const text = decoder.write(buf);
          if (text.length > 0) opts.onData(text);
          curIno = st.ino;
          offset = st.size;
          return;
        }
        if (st.size < offset) {
          const buf = await read(target, 0, st.size);
          decoder = new StringDecoder("utf8");
          const text = decoder.write(buf);
          if (text.length > 0) opts.onData(text);
          offset = st.size;
          return;
        }
        if (st.size > offset) {
          const buf = await read(target, offset, st.size - offset);
          const text = decoder.write(buf);
          if (text.length > 0) opts.onData(text);
          offset = st.size;
        }
      } catch {
        // stat/read 실패(세대 회전·삭제 경합 등 ENOENT) — 이 관측만 skip, 다음 관측에서 수렴.
      } finally {
        observing = false;
        if (pending && !stopped) {
          pending = false;
          void observe().catch(() => {});
        }
      }
    };

    const watchListener = (_eventType: string, filename: string | null): void => {
      if (filename !== null && filename !== targetName) return;
      void observe().catch(() => {});
    };
    const watcher = watch(dirname(target), watchListener, (err) => {
      if (!stopped) opts.onWatchError?.(err);
    });

    const timer = setIntervalFn(() => {
      void observe().catch(() => {});
    }, pollMs);

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      watcher.close();
      clearIntervalFn(timer);
      resolve();
    };

    opts.signal.addEventListener("abort", stop, { once: true });
  });
}
