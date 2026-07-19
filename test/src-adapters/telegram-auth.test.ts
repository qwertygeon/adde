import { describe, expect, it } from "vitest";
import {
  isAuthorizedSender,
  selfAuthorizedChatId,
  resolveTelegramAuth,
} from "../../src/src-adapters/telegram.js";
import type { LaneConf } from "../../src/shared/conf.js";

/** 테스트용 최소 LaneConf — telegram 네임스페이스 인증 필드만 지정. */
function conf(tg: { chat_id?: string; allow_from?: string }): LaneConf {
  return {
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
    perm_tier: "acp",
    acp_version: "v1",
    allowlist: [],
    denylist: [],
    hard_deny: [],
    auto_relaunch: true,
    ...(Object.keys(tg).length > 0 ? { telegram: tg } : {}),
  };
}

// 인바운드/콜백 발신자 인증(순수) — 허용 집합이 비면 fail-closed(전부 거부),
// 후보 id(chat.id/from.id) 중 하나라도 집합에 있으면 허용.

describe("isAuthorizedSender", () => {
  it("허용 집합이 비면 항상 false (fail-closed — 미설정 시 전 인바운드 거부)", () => {
    expect(isAuthorizedSender(new Set(), [123, 456])).toBe(false);
    expect(isAuthorizedSender(new Set(), [undefined])).toBe(false);
  });

  it("후보 중 하나가 허용 집합에 있으면 true", () => {
    const authorized = new Set([100, 200]);
    expect(isAuthorizedSender(authorized, [200, 999])).toBe(true); // from.id 매칭
    expect(isAuthorizedSender(authorized, [100])).toBe(true); // chat.id 매칭
  });

  it("모든 후보가 집합 밖이면 false (미허가 발신자)", () => {
    const authorized = new Set([100]);
    expect(isAuthorizedSender(authorized, [999, 888])).toBe(false);
  });

  it("undefined 후보는 무시한다 (from 없는 채널 메시지 등)", () => {
    const authorized = new Set([100]);
    expect(isAuthorizedSender(authorized, [undefined, 100])).toBe(true);
    expect(isAuthorizedSender(authorized, [undefined, 999])).toBe(false);
  });

  it("음수 id(그룹 chat)도 매칭한다", () => {
    const authorized = new Set([-1001234567890]);
    expect(isAuthorizedSender(authorized, [-1001234567890, 42])).toBe(true);
  });
});

describe("selfAuthorizedChatId (개인 chat 만 자기 인증)", () => {
  it("양수 chat_id(개인 chat)는 자기 인증 앵커로 포함된다", () => {
    expect(selfAuthorizedChatId(12345)).toBe(12345);
  });

  it("음수 chat_id(그룹/채널)는 제외된다 — 멤버는 allow_from 으로만 인증", () => {
    expect(selfAuthorizedChatId(-1001234567890)).toBeUndefined();
  });

  it("미지정(undefined)은 undefined", () => {
    expect(selfAuthorizedChatId(undefined)).toBeUndefined();
  });

  it("그룹 chat_id 만으로는 멤버가 인증되지 않는다 (blanket 허용 방지)", () => {
    // 그룹 chat_id 는 authorized 에 안 들어가므로, 멤버는 allow_from 으로만 통과.
    const groupId = -100;
    const authorized = new Set<number>(); // selfAuthorizedChatId(groupId) === undefined → 비어있음
    const self = selfAuthorizedChatId(groupId);
    if (self !== undefined) authorized.add(self);
    // 그룹 chat.id 로도, 임의 멤버 from.id 로도 통과 불가(allow_from 없으면 fail-closed)
    expect(isAuthorizedSender(authorized, [groupId, 999])).toBe(false);
    // allow_from 에 멤버를 넣으면 그 멤버만 통과
    authorized.add(111);
    expect(isAuthorizedSender(authorized, [groupId, 111])).toBe(true);
    expect(isAuthorizedSender(authorized, [groupId, 999])).toBe(false);
  });
});

// conf(chat_id ∪ allow_from) → 회신 대상·인증셋 조립. supervisor 인라인에서 telegram 어댑터로
// 이관된 로직(B3) — fail-closed·개인/그룹 chat 구분·CSV 파싱 불변식을 직접 잠근다.
describe("resolveTelegramAuth (conf → 인증셋 조립)", () => {
  it("chat_id·allow_from 모두 없으면 fail-closed (chatId undefined, authorizedIds 빔)", () => {
    const r = resolveTelegramAuth(conf({}));
    expect(r.chatId).toBeUndefined();
    expect(r.authorizedIds).toEqual([]);
  });

  it("개인 chat_id(양수)는 회신 대상이자 자기 인증 앵커로 포함된다", () => {
    const r = resolveTelegramAuth(conf({ chat_id: "12345" }));
    expect(r.chatId).toBe(12345);
    expect(r.authorizedIds).toContain(12345);
  });

  it("그룹 chat_id(음수)는 회신 대상이지만 인증 앵커에서 제외된다 (blanket 허용 방지)", () => {
    const r = resolveTelegramAuth(conf({ chat_id: "-1001234567890" }));
    expect(r.chatId).toBe(-1001234567890);
    expect(r.authorizedIds).toEqual([]); // 자기 인증 미포함 → allow_from 없으면 fail-closed
  });

  it("allow_from CSV 는 트림·빈값·NaN 제외로 파싱된다", () => {
    const r = resolveTelegramAuth(conf({ allow_from: " 111 , 222 ,, x , 333 " }));
    expect(r.authorizedIds).toEqual([111, 222, 333]);
  });

  it("개인 chat_id + allow_from 는 합쳐진다 (chat_id 앵커 + 멤버들)", () => {
    const r = resolveTelegramAuth(conf({ chat_id: "500", allow_from: "111,222" }));
    expect(r.chatId).toBe(500);
    expect(r.authorizedIds).toEqual([500, 111, 222]);
  });

  it("그룹 chat_id + allow_from 는 멤버만 인증(그룹 앵커 없음)", () => {
    const r = resolveTelegramAuth(conf({ chat_id: "-100", allow_from: "111" }));
    expect(r.chatId).toBe(-100);
    expect(r.authorizedIds).toEqual([111]);
  });

  it("비수치 chat_id 는 undefined 로 처리(회신 비활성)", () => {
    const r = resolveTelegramAuth(conf({ chat_id: "notanumber" }));
    expect(r.chatId).toBeUndefined();
    expect(r.authorizedIds).toEqual([]);
  });
});
