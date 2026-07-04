/**
 * 액션형 알림 포매터 — 차단·예외 시 "상황 + 조치" 2요소를 일관 포맷.
 * 운영자가 무엇이 일어났고(상황) 어떻게 대응할지(조치)를 항상 함께 받도록 한다.
 * 시크릿 노출 방지를 위해 최종 문자열에 마스킹을 적용한다.
 */
import { maskSecrets } from "./mask.js";
import { t } from "./i18n.js";

export interface ActionableNote {
  /** 무슨 상황인가. */
  situation: string;
  /** 어떻게 조치하는가. */
  action: string;
}

/** 포매터가 받는 로케일 고정 t (레인별 채널 로케일). 미지정 시 전역 로케일. */
export type NotifyT = typeof t;

/** fail-closed 차단 알림. */
export function formatBlock(note: ActionableNote, tl: NotifyT = t): string {
  return maskSecrets(tl("notify.block", { situation: note.situation, action: note.action }));
}

/** 비차단 예외(오류) 알림. */
export function formatException(note: ActionableNote, tl: NotifyT = t): string {
  return maskSecrets(tl("notify.exception", { situation: note.situation, action: note.action }));
}

/** 비차단 경고 알림 — 진행은 계속하되 사용자가 인지해야 하는 상황. */
export function formatWarnNote(note: ActionableNote, tl: NotifyT = t): string {
  return maskSecrets(tl("notify.warn", { situation: note.situation, action: note.action }));
}
