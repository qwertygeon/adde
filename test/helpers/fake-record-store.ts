/**
 * SessionManager/TurnRunner 주입용 RecordStore 더블 — design.md §인터페이스 계약(RecordStore)의
 * 형태를 permissive 하게 흉내낸다. 내부 필드 사용 방식이 tasks.md 확정 시그니처 밖(design.md 본문
 * 인터페이스)이라, 정확한 호출 규약이 Development 구현과 다르면 PPG-1 2차 방어(runs/pipeline-log
 * 명시 + test(AUTHORING) 부분 재작업)로 동기화한다. 본 더블은 호출을 기록(capture)해 "적절한 시점에
 * 호출됐는가" 류 단언에 쓸 수 있게 한다.
 */
import { vi } from "vitest";

export interface FakeRecordStoreCalls {
  appendEvent: unknown[];
  projectTurn: unknown[];
  project: unknown[];
}

export function makeFakeRecordStore(
  opts: { failAppendEvent?: boolean; failAppendEventForSid?: string } = {},
) {
  const calls: FakeRecordStoreCalls = { appendEvent: [], projectTurn: [], project: [] };
  const store = {
    appendEvent: vi.fn(async (sid: string, e: unknown) => {
      calls.appendEvent.push({ sid, e });
      if (
        opts.failAppendEvent ||
        (opts.failAppendEventForSid && sid === opts.failAppendEventForSid)
      ) {
        throw new Error(`[fake-record-store] appendEvent 강제 실패(sid=${sid})`);
      }
    }),
    readEvents: vi.fn(async function* (_sid: string) {
      // 기본 빈 스트림 — 재개 인덱스 등 소비측이 개별 테스트에서 override 한다.
    }),
    // 006(F5) — RecordStore.putBlob 시그니처가 (data) → (sid, data) 로 바뀐다(design.md §인터페이스
    // 계약 RecordStore — 프로덕션 소비처 0건, DI 더블만 갱신 대상).
    putBlob: vi.fn(async (sid: string, data: Buffer | string) => ({
      blob: `sha256:fake-${sid}-${String(data).length}`,
      bytes: Buffer.byteLength(String(data)),
    })),
    projectTurn: vi.fn(async (sid: string, turn: number, phase: string) => {
      calls.projectTurn.push({ sid, turn, phase });
    }),
    project: vi.fn(async (opts2?: unknown) => {
      calls.project.push(opts2);
    }),
    rebuild: vi.fn(async () => ({
      sids: [],
      turnsRendered: 0,
      dedupEntries: 0,
      corruptedLinesSkipped: 0,
    })),
  };
  return { store, calls };
}
