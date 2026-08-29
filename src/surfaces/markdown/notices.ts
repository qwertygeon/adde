/**
 * 안내 존(신규, L4) — 렌더·파싱·노트↔레코드 동기화 계획을 담당하는 순수 함수 모음(design.md §7).
 * SoT 는 세션 레코드의 `notices` — 여기서는 파생 렌더/파싱만 하고 레코드를 직접 만지지
 * 않는다(레코드 반영은 `SessionManager.applyNoticeSync` 가 수행). `NOTICES_SENTINEL` 은 `inbox.ts`
 * 가 소유하므로 여기서 import 한다 — `inbox.ts` 의 `healLayout` 은 반대로 `renderNoticeZone` 을
 * import 한다(상호 참조 — 둘 다 함수 본문 안에서만 쓰여 ESM 순환 import 로 안전하다).
 */
import { NOTICES_SENTINEL } from "./inbox.js";
import { sanitizeEngineText } from "../../shared/mask.js";
import type { NoticeEntry } from "../../core/session-store.js";

export { planNoticeCap } from "../../core/session-store.js";

/** 안내 줄 말미 센티널 — read: `<!-- n:{id} -->`, prompt 옵션: `<!-- n:{id} r:{token} -->`. */
const NOTICE_LINE = /^\s*-\s*\[([ xX])\]\s+.*<!--\s*n:(\S+?)(?:\s+r:(\S+))?\s*-->\s*\r?$/;
/** prompt 절단·정보 줄(체크박스 없음) — 배제 판정에만 쓰인다(치유 draft 필터가 재사용). */
const NOTICE_INFO_LINE = /^\s*>\s*ℹ️/;

/** 안내 존 내용 줄인가(센티널 포함 체크박스 · 정보 줄) — `inbox.ts` 의 draft 필터가 재사용한다. */
export function isNoticeContentLine(line: string): boolean {
  return NOTICE_LINE.test(line) || NOTICE_INFO_LINE.test(line) || line.trim() === NOTICES_SENTINEL;
}

/**
 * 안내 존 렌더(read: 문구 + 센티널 · prompt: 옵션 줄 N + 절단 정보줄) — 항목 0건이면 빈 배열(존 자체가
 * 생기지 않는다, "안내 있을 때만"). `text`·`options[].label`·`footer` 를 모두 여기서 살균한다 —
 * 여기가 유일한 렌더 초크포인트라, push 시점 살균(`addNoticeToRecord`, `text` 만 대상)에서 빠진
 * `label`·`footer`뿐 아니라 디스크에서 그대로 로드된 구버전 레코드까지 한 지점에서 함께 덮인다
 * (보안 검토 — push 1회 살균만으로는 로드분을 못 덮었다). 살균은 제어문자(개행 포함)를 공백으로
 * 접으므로, 라벨·footer 내부의 개행으로 위조 체크박스·센티널 줄을 만들어내는 breakout 이 막힌다.
 */
export function renderNoticeZone(notices: readonly NoticeEntry[]): string[] {
  if (notices.length === 0) return [];
  const out: string[] = [NOTICES_SENTINEL];
  for (const n of notices) {
    if (n.mode === "prompt") {
      for (const opt of n.options ?? []) {
        out.push(`- [ ] ▶️ ${sanitizeEngineText(opt.label)} <!-- n:${n.id} r:${opt.token} -->`);
      }
      if (n.footer) out.push(`> ℹ️ ${sanitizeEngineText(n.footer)}`);
    } else {
      out.push(`- [ ] 📣 ${sanitizeEngineText(n.text)} <!-- n:${n.id} -->`);
    }
  }
  return out;
}

/** 노트에 실려 있는 안내 줄(체크 상태·옵션 토큰)을 파싱한다 — 전체 라인 배열에서 패턴 매칭만 한다. */
export function parseNoticeZone(
  lines: readonly string[],
): Array<{ id: string; checked: boolean; optionToken?: string }> {
  const out: Array<{ id: string; checked: boolean; optionToken?: string }> = [];
  for (const line of lines) {
    const m = NOTICE_LINE.exec(line);
    if (!m) continue;
    const entry: { id: string; checked: boolean; optionToken?: string } = {
      id: m[2]!,
      checked: m[1]!.toLowerCase() === "x",
    };
    if (m[3]) entry.optionToken = m[3];
    out.push(entry);
  }
  return out;
}

/**
 * 레코드 안내(`notices`)와 노트 관측(`parseNoticeZone` 결과)을 대조해 다음 상태를 계획한다
 * (design.md §7 동기화 규칙 표). `noteExists=false`(아직 렌더된 적 없음 — 파일 자체가 새로 만들어짐
 * 등)면 전부 유지(렌더 대기)만 하고 소비 판정을 하지 않는다.
 */
export function planNoticeSync(
  notices: readonly NoticeEntry[],
  parsed: ReturnType<typeof parseNoticeZone>,
  noteExists: boolean,
): {
  keep: NoticeEntry[];
  consumed: string[];
  chosen?: { id: string; token: string };
  cancelled?: string;
  /** 렌더 확정 전이라 부재를 취소/읽음으로 해석하지 못하고 유지한 항목 id 들(crash-consistency 의
   * "조용한 되살림" 을 알리기 위한 신호 — 호출자가 안내로 표면화한다). */
  notYetReflected: string[];
} {
  if (!noteExists) {
    return { keep: [...notices], consumed: [], notYetReflected: [] };
  }

  const byId = new Map<string, Array<{ checked: boolean; optionToken?: string }>>();
  for (const p of parsed) {
    const arr = byId.get(p.id) ?? [];
    arr.push({ checked: p.checked, ...(p.optionToken ? { optionToken: p.optionToken } : {}) });
    byId.set(p.id, arr);
  }

  const keep: NoticeEntry[] = [];
  const consumed: string[] = [];
  const notYetReflected: string[] = [];
  let chosen: { id: string; token: string } | undefined;
  let cancelled: string | undefined;

  for (const n of notices) {
    const observed = byId.get(n.id);

    if (n.mode === "prompt") {
      const totalOptions = n.options?.length ?? 0;
      if (!observed || observed.length === 0) {
        if (n.rendered) {
          consumed.push(n.id); // 옵션 줄이 전부 사라짐 — 취소.
          cancelled = n.id;
        } else {
          keep.push(n); // 렌더 전 — 유지.
          notYetReflected.push(n.id);
        }
        continue;
      }
      // 관측된 token 을 이 안내 항목이 실제로 발행한 token 집합과 대조한다(보안 검토 — 종전엔
      // 노트에서 읽은 값을 그대로 `applyResume` 의 sid 로 소비해, 집합 밖 문자열도 그대로
      // 통과했다). 집합 밖이면 "선택 없음" 과 동일하게 취급해 아래 재렌더 경로로 떨어진다.
      const validTokens = new Set((n.options ?? []).map((o) => o.token));
      const checkedOpt = observed.find(
        (o) => o.checked && o.optionToken && validTokens.has(o.optionToken),
      );
      if (checkedOpt?.optionToken) {
        consumed.push(n.id); // 하나 선택 — 그 세션 재개 + prompt 항목 전체 제거.
        chosen = { id: n.id, token: checkedOpt.optionToken };
        continue;
      }
      // 일부만 남았거나(부분 삭제) 전부 그대로임 — 어느 쪽도 취소가 아니다(치유가 재렌더).
      void totalOptions;
      keep.push({ ...n, rendered: true });
      continue;
    }

    // mode === "read"
    if (!observed || observed.length === 0) {
      if (n.rendered) {
        consumed.push(n.id); // 사용자가 줄을 지웠다 → 읽음 처리.
      } else {
        keep.push(n); // 아직 렌더되지 않은 항목의 부재는 읽음이 아니다(crash-consistency).
        notYetReflected.push(n.id);
      }
      continue;
    }
    if (observed.some((o) => o.checked)) {
      consumed.push(n.id); // 체크됨 → 읽음 처리.
    } else {
      keep.push({ ...n, rendered: true });
    }
  }

  return {
    keep,
    consumed,
    ...(chosen ? { chosen } : {}),
    ...(cancelled ? { cancelled } : {}),
    notYetReflected,
  };
}
