/**
 * `adde factory-reset` — 모든 프로젝트·세션을 지워 처음 설치 상태로 되돌린다.
 * 명령 전용(노트·팔레트 경로 없음, SC-075). 비대화 거부(fail-closed) → 인벤토리 선표시 →
 * 강한 문구 + 고정 문구 타이핑(정확 일치) → 6단계 실행 → 결과·보존·실패 보고 → stray 별도 확인.
 */
import { defaultBase, projectPaths } from "../shared/paths.js";
import { daemonMarkerAlive } from "../core/control-queue.js";
import {
  buildResetInventory,
  executeFactoryReset,
  FACTORY_RESET_PHRASE,
} from "../core/factory-reset.js";
import type { FactoryResetDeps, ResetInventory } from "../core/factory-reset.js";
import { createPrompter, askPhrase, askYesNo } from "./prompt.js";
import type { Prompter } from "./prompt.js";
import { EXIT, cmdError } from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { foldControlChars } from "../shared/mask.js";

export interface RunFactoryResetDeps {
  prompter?: Prompter;
  interactive?: boolean;
  base?: string;
  reset?: Partial<FactoryResetDeps>;
}

async function defaultStopDaemon(proj: string): Promise<void> {
  const { unloadDaemon } = await import("../core/launchd.js");
  await unloadDaemon(proj);
}

function makeDefaultDaemonResidue(base: string): (proj: string) => Promise<boolean> {
  return async (proj: string): Promise<boolean> => {
    const { daemonRegState } = await import("../core/launchd.js");
    const reg = await daemonRegState(proj);
    if (reg.launchctlRegistered) return true;
    return daemonMarkerAlive(projectPaths(base, proj));
  };
}

/**
 * 파괴 동의의 근거 화면 — 여기 실리는 문자열은 전부 외부 유래다(conf 의 `vault` 값·`<base>/projects`
 * 하위 디렉터리 이름·v0.2.x 디렉터리 이름). 제어문자를 접지 않으면 실개행·단독 CR·ANSI CSI 로 위조
 * 줄("삭제할 대상이 없습니다" 등)을 끼워 넣어 사용자가 삭제 반경을 오판할 수 있으므로, 표시 직전
 * `foldControlChars`(초크포인트, `shared/mask.ts`)로 접는다.
 *
 * 살균은 **표시에만** 적용한다 — 삭제 대상 경로·내부 비교에는 원문을 그대로 쓴다(살균한 문자열로
 * 지우면 화면과 다른 경로를 지운다). 시크릿 마스킹·길이 절단을 쓰지 않는 것도 같은 이유다: 경로가
 * `***` 로 바뀌거나 꼬리가 잘리면 어느 vault 를 지우는지 확인할 수 없다.
 */
function formatInventory(inv: ResetInventory): string {
  const lines: string[] = [`프로젝트: ${inv.projects.length}개`];
  for (const p of inv.projects) {
    const proj = foldControlChars(p.proj);
    lines.push(`  - ${proj} (세션 ${p.sessions}개, vault=${foldControlChars(p.vaultRoot)})`);
  }
  if (inv.unresolvedProjects.length > 0) {
    const names = inv.unresolvedProjects.map((n) => foldControlChars(n)).join(", ");
    lines.push(`해석 불가(삭제 대상에서 제외): ${names}`);
  }
  if (inv.legacy.length > 0) {
    const names = inv.legacy.map((l) => foldControlChars(l.proj)).join(", ");
    lines.push(`v0.2.x(보존 대상 — 건드리지 않음): ${names}`);
  }
  if (inv.strays.length > 0) {
    lines.push(`설정이 가리키지 않는 vault 잔존물(별도 확인 대상): ${inv.strays.length}건`);
  }
  if (inv.vaultUnresolvable.length > 0) {
    lines.push(
      `vault 를 해석할 수 없는 프로젝트(별도 확인 대상): ${inv.vaultUnresolvable.length}건`,
    );
    for (const v of inv.vaultUnresolvable) {
      const proj = foldControlChars(v.proj);
      const vault = foldControlChars(v.vaultRoot);
      lines.push(`  - ${proj} (vault=${vault}, 사유: ${foldControlChars(v.reason)})`);
    }
  }
  return lines.join("\n");
}

export async function runFactoryReset(
  argv: readonly string[],
  deps: RunFactoryResetDeps = {},
): Promise<number> {
  void argv; // 인자·플래그 0개 — 파서 스펙(`factory-reset`: flags:[], positional 없음)이 강제.
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  if (!interactive) {
    process.stderr.write(
      cmdError("factory-reset", "비대화 환경에서는 실행할 수 없습니다(안전을 위해 거부합니다).") +
        "\n",
    );
    return EXIT.USAGE;
  }

  const base = deps.base ?? defaultBase();
  const resetDeps: FactoryResetDeps = {
    base,
    stopDaemon: deps.reset?.stopDaemon ?? defaultStopDaemon,
    daemonResidue: deps.reset?.daemonResidue ?? makeDefaultDaemonResidue(base),
  };

  // `buildResetInventory` 호출을 try 안으로 옮긴다(보안 검토 — 종전엔 try 밖이라, 이름 충돌 거부
  // (`detectProjectsNameCollision`)나 불안전 이름 등으로 throw 하면 raw 스택이 그대로 노출되고
  // 파괴적 명령이 미확인 예외로 종료됐다). 이제 사용자 문구(`cmdError`)로 일관되게 보고한다.
  const prompter = deps.prompter ?? createPrompter();
  try {
    const inventory = await buildResetInventory(resetDeps);
    // vault 해석 불가 프로젝트는 "삭제 대상 0" 이어도 설정 삭제 동의를 물을 대상이므로 조기
    // 종료에서 제외한다 — 조용히 끝내면 사용자가 그 프로젝트의 존재조차 알 수 없다.
    if (
      inventory.projects.length === 0 &&
      inventory.strays.length === 0 &&
      inventory.vaultUnresolvable.length === 0
    ) {
      process.stdout.write("삭제할 대상이 없습니다(프로젝트 0개).\n");
      return EXIT.OK;
    }

    process.stdout.write(formatInventory(inventory) + "\n\n");
    process.stdout.write(
      "⚠️ 공장 초기화 — 모든 프로젝트와 세션의 노트가 삭제됩니다. 복구할 수 없습니다.\n",
    );

    const confirmed = await askPhrase(
      prompter.ask,
      "계속하려면 문구를 정확히 입력하세요",
      FACTORY_RESET_PHRASE,
    );
    if (!confirmed) {
      process.stderr.write("문구가 일치하지 않아 취소되었습니다 — 아무것도 지우지 않았습니다.\n");
      return EXIT.FAIL;
    }

    let deleteStrays = false;
    if (inventory.strays.length > 0) {
      deleteStrays = await askYesNo(
        prompter.ask,
        `설정이 가리키지 않는 vault 잔존물 ${inventory.strays.length}건도 삭제하시겠습니까?`,
        false,
      );
    }

    let deleteConfigOfUnresolvableVault = false;
    if (inventory.vaultUnresolvable.length > 0) {
      deleteConfigOfUnresolvableVault = await askYesNo(
        prompter.ask,
        `vault 를 찾을 수 없는 프로젝트 ${inventory.vaultUnresolvable.length}건의 설정만 ` +
          "지우시겠습니까? (vault 에 남은 데이터의 위치 단서가 사라집니다)",
        false,
      );
    }

    const report = await executeFactoryReset(
      inventory,
      { deleteStrays, deleteConfigOfUnresolvableVault },
      resetDeps,
    );
    if (report.failures.length > 0) {
      process.stderr.write(
        cmdError(
          "factory-reset",
          `일부 실패: ${report.failures
            .map((f) => `${foldControlChars(f.path)}(${foldControlChars(f.reason)})`)
            .join(", ")}`,
        ) + "\n",
      );
      return EXIT.FAIL;
    }
    const preservedLegacyLine =
      report.preservedLegacy.length > 0
        ? `보존한 v0.2.x: ${report.preservedLegacy.map((l) => foldControlChars(l)).join(", ")}\n`
        : "";
    const preservedStraysLine =
      report.preservedStrays.length > 0 ? `보존한 stray: ${report.preservedStrays.length}건\n` : "";
    const preservedUnresolvableLine =
      report.preservedUnresolvable.length > 0
        ? `보존한 프로젝트(vault 해석 불가, 설정 유지): ${report.preservedUnresolvable
            .map((e) => foldControlChars(e))
            .join(", ")}\n`
        : "";
    process.stdout.write(
      `초기화 완료 — 프로젝트 ${report.removedProjects.length}개 제거.\n` +
        preservedLegacyLine +
        preservedStraysLine +
        preservedUnresolvableLine +
        "한계: 설정이 가리키지 않는 vault 잔존물은 발견 대상이 아닙니다.\n",
    );
    return EXIT.OK;
  } catch (err) {
    process.stderr.write(cmdError("factory-reset", errMsg(err)) + "\n");
    return EXIT.FAIL;
  } finally {
    if (!deps.prompter) prompter.close();
  }
}
