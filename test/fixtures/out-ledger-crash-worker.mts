/**
 * 실 OS 프로세스 크래시 주입 워커(PROC-R18) — out-ledger 전이 지점 사이에서 실제 프로세스를
 * 종료시켜 크래시창을 재현한다. 워커 내 함수 직접호출·타이머 모킹으로 갈음하지 않고, 매 모드가
 * 완료한 쓰기까지만 실 fs 에 durable 하게 남긴 채 별도 프로세스로서 종료한다(013-out-state-ledger
 * D-07, tasks.md 테스트 런타임 제약). CLI: node --import tsx out-ledger-crash-worker.mts
 *   <tmpBase> <proj> <lane> <mode> [...args]
 */
import { writeOutBody, setDone, setSending, setSent, migrateLegacyOut } from "../../src/core/out-ledger.js";
import { lanePaths } from "../../src/shared/paths.js";

async function main(): Promise<void> {
  const [, , tmpBase, proj, lane, mode, ...rest] = process.argv;
  if (!tmpBase || !proj || !lane || !mode) {
    process.stderr.write("usage: <tmpBase> <proj> <lane> <mode> [...args]\n");
    process.exit(2);
  }
  const paths = lanePaths(tmpBase, proj, lane);

  switch (mode) {
    case "body-then-crash": {
      // SC-005: 전이 두 쓰기(body→ledger) 사이 크래시 — body 는 확정, ledger done 커밋 전 종료.
      const [id] = rest;
      await writeOutBody(paths, id!, "전이중 응답");
      process.exit(1);
      break;
    }
    case "done-then-crash": {
      // 베이스라인(전이 후) — body+ledger done 확정 후 종료. SC-005 의 "후" 상태 비교 기준.
      const [id] = rest;
      await writeOutBody(paths, id!, "완료된 응답");
      await setDone(paths, id!, {});
      process.exit(1);
      break;
    }
    case "sending-then-crash": {
      // SC-006: 비멱등(telegram) 전달 시작 후 sent 기록 전 크래시.
      const [id] = rest;
      await writeOutBody(paths, id!, "전송 중이던 응답");
      await setDone(paths, id!, {});
      await setSending(paths, id!);
      process.exit(1);
      break;
    }
    case "sent-then-crash": {
      // 베이스라인 — 정상 종단(sent) 후 종료. SC-006 의 "정상 완료" 대조군.
      const [id] = rest;
      await writeOutBody(paths, id!, "전송 완료된 응답");
      await setDone(paths, id!, {});
      await setSending(paths, id!);
      await setSent(paths, id!);
      process.exit(1);
      break;
    }
    case "migrate": {
      // SC-013: 레거시 마커 1회성 마이그레이션 — 실 프로세스 기동 경로.
      const result = await migrateLegacyOut(paths);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
      break;
    }
    default:
      process.stderr.write(`unknown mode: ${mode}\n`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err));
  process.exit(3);
});
