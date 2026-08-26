/**
 * 승인 노트 렌더·파싱(FR-026·FR-040) — 현행 `src-adapters/markdown.ts` 의 승인 블록 로직 이식.
 * 결정이 이벤트에 기록된 것을 확인한 뒤에만 파일을 삭제한다(ADR-016 — 삭제는 gate 배선부 소관).
 */
import type { PermRequest } from "../../gate/gate.js";
import { sanitizeEngineText } from "../../shared/mask.js";

function formatStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const PERM_MARKER = /<!--\s*adde:perm\s+id=(\S+)\s+status=(\S+)\s*-->/;
const ALLOW_CHECKED = /^\s*-\s*\[x\]\s+.*\ballow\b/i;
const DENY_CHECKED = /^\s*-\s*\[x\]\s+.*\bdeny\b/i;

/** 권한 요청 1건을 승인 노트 블록 문자열로 렌더(전체 파일 내용 — 요청당 파일 1개, ADR-016). */
export function renderApprovalBlock(
  req: PermRequest,
  now: Date = new Date(),
  timeoutMs = 600_000,
): string {
  // tool·cwd·표시용 id 를 detail 과 동일하게 살균한다 — tool 은 엔진(모델)이 생성하는 자유
  // 텍스트라 개행 뒤 "- [x] allow" 삽입으로 체크박스 파싱을 위조할 수 있다(간접 프롬프트 인젝션).
  // 마커 줄(id=)의 id 는 gate/turn-runner 가 조회에 쓰는 정확한 원본 값을 그대로 유지한다.
  const tool = sanitizeEngineText(req.tool);
  const cwd = sanitizeEngineText(req.cwd);
  const displayId = sanitizeEngineText(req.id);
  const detail = req.detail.replace(/\s+/g, " ").trim();
  const deadline = new Date(now.getTime() + timeoutMs);
  const rendered = [
    `### ⏳ req ${displayId} · ${tool}`,
    `> ${detail}  (cwd: ${cwd})`,
    `> 요청 ${formatStamp(now)} · 자동거부 기한 ${formatStamp(deadline)}`,
    `> 아래 allow 또는 deny 체크박스 하나만 체크하세요.`,
    `- [ ] allow`,
    `- [ ] deny`,
    `<!-- adde:perm id=${req.id} status=pending -->`,
    "",
    "",
  ].join("\n");

  // 심층 방어 — 정규화 후에도 렌더 결과에서 결정이 파싱되면(이론상 도달 불가능해야 함)
  // 살균 실패로 간주해 파일을 쓰지 않고 즉시 거부한다. 호출측(markdown Surface askPermission)이
  // 이 throw 를 그대로 전파하면 gate.ts 의 sendPermPrompt 오류 경로가 fail-closed deny 로 귀결한다
  // (Surface 계약 — surfaces/types.ts "askPermission: 실패는 throw(→ gate 가 deny 로 처리)").
  if (parseApprovals(rendered).decisions.length !== 0) {
    throw new Error(
      `renderApprovalBlock: 렌더된 승인 노트에서 이미 결정이 파싱됨(reqId=${req.id}) — 살균 실패로 판단해 파일을 기록하지 않습니다.`,
    );
  }

  return rendered;
}

export interface ApprovalDecision {
  reqId: string;
  decision: "allow" | "deny";
}

export interface ApprovalsParse {
  decisions: ApprovalDecision[];
  newContent: string;
  changed: boolean;
}

/** allow/deny 체크박스 정확히 하나만 체크된 경우에만 결정으로 인정(모호=pending 유지). */
export function parseApprovals(content: string): ApprovalsParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const decisions: ApprovalDecision[] = [];
  let changed = false;

  let blockStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = PERM_MARKER.exec(lines[i]!);
    if (!m) continue;
    const id = m[1]!;
    const status = m[2]!;
    const blockLines = lines.slice(blockStart, i);

    if (status === "pending") {
      const allow = blockLines.some((l) => ALLOW_CHECKED.test(l));
      const deny = blockLines.some((l) => DENY_CHECKED.test(l));
      if (allow !== deny) {
        const decision: "allow" | "deny" = allow ? "allow" : "deny";
        decisions.push({ reqId: id, decision });
        lines[i] = `<!-- adde:perm id=${id} status=${decision} -->`;
        for (let j = blockStart; j < i; j++) {
          if (/^###\s/.test(lines[j]!)) {
            lines[j] = lines[j]!.replace(
              /^###\s+⏳/,
              `### ${decision === "allow" ? "✅" : "⛔"}`,
            ).replace(/\breq\b/, `req(${decision})`);
            break;
          }
        }
        changed = true;
      }
    }
    blockStart = i + 1;
  }

  let newContent = lines.join("\n");
  if (trailingNewline && !newContent.endsWith("\n")) newContent += "\n";
  return { decisions, newContent, changed };
}

/** 타임아웃·강제 종단(fail-closed) 시 pending 블록을 deny 로 재작성. */
export function finalizeApprovalDeny(
  content: string,
  reqId: string,
  reason: string,
): ApprovalsParse {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = PERM_MARKER.exec(lines[i]!);
    if (m && m[1] === reqId && m[2] === "pending") {
      lines[i] = `<!-- adde:perm id=${reqId} status=deny reason=${reason} -->`;
      for (let j = i - 1; j >= 0; j--) {
        if (PERM_MARKER.test(lines[j]!)) break;
        if (/^###\s+⏳/.test(lines[j]!)) {
          lines[j] = lines[j]!.replace(/^###\s+⏳/, "### ⛔").replace(/\breq\b/, "req(deny)");
          break;
        }
      }
      changed = true;
    }
  }
  let newContent = lines.join("\n");
  if (trailingNewline && !newContent.endsWith("\n")) newContent += "\n";
  return { decisions: [], newContent, changed };
}
