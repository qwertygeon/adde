/**
 * 액션형 알림 포매터 — 차단·예외 시 "상황 + 조치" 2요소를 일관 포맷.
 * 운영자가 무엇이 일어났고(상황) 어떻게 대응할지(조치)를 항상 함께 받도록 한다(DEC-007).
 * 시크릿 노출 방지를 위해 최종 문자열에 마스킹을 적용한다.
 */
import { maskSecrets } from "./mask.js";

export interface ActionableNote {
  /** 무슨 상황인가. */
  situation: string;
  /** 어떻게 조치하는가. */
  action: string;
}

/** fail-closed 차단 알림. */
export function formatBlock(note: ActionableNote): string {
  return maskSecrets(`[ADDE 차단] ${note.situation}\n  ↳ 조치: ${note.action}`);
}

/** 비차단 예외(오류) 알림. */
export function formatException(note: ActionableNote): string {
  return maskSecrets(`[ADDE 오류] ${note.situation}\n  ↳ 조치: ${note.action}`);
}
