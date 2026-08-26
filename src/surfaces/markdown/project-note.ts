/**
 * 프로젝트 노트의 새 세션 생성 체크박스(FR-025) — `- [ ] ➕ new session` 체크 감지 시
 * `SessionManager.create()` 를 호출하고 결과를 기록한 뒤 체크박스를 미체크로 복원한다(멱등).
 */
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../../shared/fs-atomic.js";
import { vaultPaths } from "../../shared/paths.js";
import { ensureVaultLayout } from "../../record/vault-paths.js";
import type { SessionManagerWithLoad } from "../../core/session-manager.js";

const NEW_SESSION_CHECKED = /^(\s*-\s*\[)[xX](\]\s*➕\s*new session\s*)\r?$/;
const NEW_SESSION_ANY = /^\s*-\s*\[[ xX]\]\s*➕\s*new session\s*\r?$/;

/**
 * 프로젝트 노트를 스캔해 체크된 새 세션 트리거를 처리한다. 세션 생성 후 그 결과(sid·입력 노트 경로)를
 * 노트에 안내 줄로 남기고 체크박스는 다시 미체크로 복원한다(연속 2회 체크 = 세션 2개, 중복 생성 아님).
 */
export async function handleProjectNoteTriggers(
  vaultRoot: string,
  proj: string,
  sessionManager: SessionManagerWithLoad,
): Promise<void> {
  await ensureVaultLayout(vaultRoot, proj);
  const vp = vaultPaths(vaultRoot, proj);
  let content: string;
  try {
    content = await readFile(vp.projectNote, "utf8");
  } catch {
    return;
  }
  if (
    !NEW_SESSION_ANY.test(content) ||
    !content.split("\n").some((l) => NEW_SESSION_CHECKED.test(l))
  ) {
    return;
  }

  const lines = content.split("\n");
  const notices: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NEW_SESSION_CHECKED.test(lines[i]!)) {
      try {
        const result = await sessionManager.create({});
        const address = `sessions/${result.sid}/inbox.md`;
        await sessionManager.registerBinding(result.sid, {
          surface: "markdown",
          address,
          sid: result.sid,
        });
        notices.push(`- 세션 생성됨: \`${result.sid}\` → [[${address}|입력 노트]]`);
      } catch (err) {
        notices.push(`- 세션 생성 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
      lines[i] = lines[i]!.replace(NEW_SESSION_CHECKED, "$1 $2");
    }
  }
  if (notices.length > 0) lines.push("", ...notices);
  await atomicWrite(vp.projectNote, lines.join("\n") + (content.endsWith("\n") ? "\n" : ""));
}
