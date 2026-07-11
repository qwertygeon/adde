/**
 * 로그 라이브 tail 코어(`adde logs --follow/-f`) — 읽기 전용, CLI 비의존(A-P007).
 * 폴링 stat + offset/inode 추적(tail -F 시맨틱)으로 세대 회전(rename)·truncate 를 결정적으로 처리한다.
 * 무손실 보장 범위는 마지막 poll 시점까지다(초고속 연쇄 회전의 이론적 한계는 GAP-002 참조).
 */
import { stat as fsStat, open } from "node:fs/promises";

/** stat/read 주입 포인트 — 미지정 시 Node 기본 구현(단위 테스트는 결정적 시퀀스를 주입). */
export interface FollowDeps {
  /** 경로의 inode·size 조회. 부재(회전 순간 등)면 null. */
  stat?: (p: string) => Promise<{ ino: number; size: number } | null>;
  /** offset..offset+length 바이트 범위를 텍스트로 읽는다. */
  read?: (p: string, offset: number, length: number) => Promise<string>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface FollowOptions {
  /** 신규 라인 청크 sink(호출측이 stdout 등에 쓴다). */
  onData: (chunk: string) => void;
  /** abort 시 즉시 정지(SIGINT 등). */
  signal: AbortSignal;
  /** 폴링 간격 ms(기본 250). */
  pollMs?: number;
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
  if (length <= 0) return "";
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
};

/**
 * 대상 파일을 폴링 추적하며 신규 라인을 `onData` 로 방출한다. `signal` abort 시 즉시 정지하고 resolve.
 * 매 tick: stat 부재(회전 순간)→skip / inode 변경→회전(새 파일 offset 0 부터 읽기) /
 * size<offset→truncate(offset 0 재조정 후 다시 읽기) / size>offset→append(증분 읽기) / 그 외 무변화.
 */
export function followFile(target: string, opts: FollowOptions): Promise<void> {
  const stat = opts.deps?.stat ?? defaultStat;
  const read = opts.deps?.read ?? defaultRead;
  const setIntervalFn = opts.deps?.setInterval ?? setInterval;
  const clearIntervalFn = opts.deps?.clearInterval ?? clearInterval;
  const pollMs = opts.pollMs ?? 250;

  return new Promise((resolve) => {
    let curIno = opts.startIno;
    let offset = opts.startOffset;
    // 이전 tick 이 아직 진행 중(느린 read 등)일 때 겹쳐 실행하지 않기 위한 가드.
    let ticking = false;

    if (opts.signal.aborted) {
      resolve();
      return;
    }

    const tick = async (): Promise<void> => {
      if (ticking) return;
      ticking = true;
      try {
        const st = await stat(target);
        if (st === null) return;
        if (st.ino !== curIno) {
          const chunk = await read(target, 0, st.size);
          if (chunk.length > 0) opts.onData(chunk);
          curIno = st.ino;
          offset = st.size;
          return;
        }
        if (st.size < offset) {
          const chunk = await read(target, 0, st.size);
          if (chunk.length > 0) opts.onData(chunk);
          offset = st.size;
          return;
        }
        if (st.size > offset) {
          const chunk = await read(target, offset, st.size - offset);
          if (chunk.length > 0) opts.onData(chunk);
          offset = st.size;
        }
      } finally {
        ticking = false;
      }
    };

    const timer = setIntervalFn(() => {
      void tick();
    }, pollMs);
    // 이벤트루프를 follow 타이머만으로 붙잡아두지 않는다(정상 종료 경로가 이미 abort 로 확보됨).
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }

    opts.signal.addEventListener(
      "abort",
      () => {
        clearIntervalFn(timer);
        resolve();
      },
      { once: true },
    );
  });
}
