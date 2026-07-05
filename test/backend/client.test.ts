import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  shouldAutoAllow,
  shouldAutopass,
  decideAutoAllow,
  isHardDenied,
  resolvePermDecision,
  extractPermDecision,
  recordToolName,
  resolveToolName,
} from "../../src/backend/acp/client.js";

// A2/DEC-002: allowlist auto-allow 판정
describe("shouldAutoAllow (A2 allowlist)", () => {
  it("도구명이 allowlist 에 있으면 true", () => {
    expect(shouldAutoAllow(["Read", "Grep"], "Read")).toBe(true);
  });
  it("allowlist 에 없으면 false (게이트 경로 유지)", () => {
    expect(shouldAutoAllow(["Read"], "Bash")).toBe(false);
  });
  it("allowlist 미지정/빈 배열이면 false", () => {
    expect(shouldAutoAllow(undefined, "Read")).toBe(false);
    expect(shouldAutoAllow([], "Read")).toBe(false);
  });
});

// SC-010: available_commands_update 이벤트를 수신해도 무크래시 처리
// fake ACP quirk 재현: turn 완료 전 prompt 큐잉·protocolVersion 1 스키마 형태

// 구독 핸들러의 available_commands_update 크래시-안전은 integration/transcript.test.ts 구독 경로에서,
// turn 완료 전 큐잉 quirk 는 core/queue.test.ts·queue-safety.test.ts 에서 실제로 검증한다.

// DEC-001/002 (005-gate-auto-respond): autopass 판정 — denylist 외 자동 허용, denylist 는 채널 승인 폴백
describe("shouldAutopass (005 autopass)", () => {
  it("perm_tier=autopass 이고 denylist 에 없는 도구는 true (자동 허용)", () => {
    expect(shouldAutopass({ perm_tier: "autopass", denylist: ["Bash"] }, "Read")).toBe(true);
  });

  it("denylist 에 있는 도구는 false (채널 승인 폴백)", () => {
    expect(shouldAutopass({ perm_tier: "autopass", denylist: ["Bash"] }, "Bash")).toBe(false);
  });

  it("denylist 미지정 autopass 는 전 도구 true", () => {
    expect(shouldAutopass({ perm_tier: "autopass" }, "Bash")).toBe(true);
  });

  it("perm_tier=acp 또는 정책 미지정이면 항상 false (기본 동작 불변)", () => {
    expect(shouldAutopass({ perm_tier: "acp", denylist: ["Bash"] }, "Read")).toBe(false);
    expect(shouldAutopass(undefined, "Read")).toBe(false);
  });

  it("알 수 없는 perm_tier(오타)는 false — acp 처럼 동작(안전 방향)", () => {
    expect(shouldAutopass({ perm_tier: "autopas" }, "Read")).toBe(false);
  });
});

// DEC-006: 매칭 키는 toolCall.title 이 아니라 원시 도구명이다.
// 실제 claude-agent-acp quirk 재현: requestPermission.toolCall = {toolCallId, rawInput, title} 뿐이고
// title 은 인자 포함 표시 문자열(Bash → "`rm -rf build/`", Write → "Write /abs/path") —
// 원시 도구명은 tool_call 세션 업데이트의 _meta.claudeCode.toolName 으로만 온다.
describe("도구명 채집·해석·자동 허용 판정 (DEC-006)", () => {
  it("tool_call 업데이트에서 도구명을 채집하고 toolCallId 로 해석한다", () => {
    const map = new Map<string, string>();
    recordToolName(map, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "`rm -rf build/`",
      kind: "execute",
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    expect(resolveToolName(map, { toolCallId: "t1", title: "`rm -rf build/`" })).toBe("Bash");
  });

  it("실제 형식 title 의 Bash 도 denylist=Bash 에 걸린다 (title 정확일치 매칭이면 가짜 통과)", () => {
    const map = new Map<string, string>();
    recordToolName(map, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "`rm -rf build/`",
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    const resolved = resolveToolName(map, { toolCallId: "t2", title: "`rm -rf build/`" });
    expect(decideAutoAllow({ perm_tier: "autopass", denylist: ["Bash"] }, resolved)).toBeNull(); // 채널 승인 폴백
  });

  it("도구명 미해석(맵 미채집·_meta 부재) 시 자동 허용하지 않는다 (fail-closed)", () => {
    const resolved = resolveToolName(new Map(), { toolCallId: "unknown", title: "Write /etc/x" });
    expect(resolved).toBeUndefined();
    expect(decideAutoAllow({ perm_tier: "autopass", denylist: [] }, resolved)).toBeNull();
    expect(decideAutoAllow({ perm_tier: "acp", allowlist: ["Write"] }, resolved)).toBeNull();
  });

  it("autopass 에서 denylist 가 allowlist 보다 우선한다 (교집합 도구는 채널 승인)", () => {
    expect(
      decideAutoAllow({ perm_tier: "autopass", allowlist: ["Bash"], denylist: ["Bash"] }, "Bash"),
    ).toBeNull();
  });

  it("autopass 에서 denylist 외 도구는 autopass 로, allowlist 도구는 allowlist 로 판정", () => {
    const policy = { perm_tier: "autopass", allowlist: ["Read"], denylist: ["Bash"] };
    expect(decideAutoAllow(policy, "Read")).toBe("allowlist");
    expect(decideAutoAllow(policy, "Write")).toBe("autopass");
    expect(decideAutoAllow(policy, "Bash")).toBeNull();
  });

  it("acp 티어는 allowlist 만 자동 허용, 그 외 null (기본 동작 불변)", () => {
    expect(decideAutoAllow({ perm_tier: "acp", allowlist: ["Read"] }, "Read")).toBe("allowlist");
    expect(decideAutoAllow({ perm_tier: "acp", allowlist: ["Read"] }, "Bash")).toBeNull();
  });

  it("tool_call 이 아닌 업데이트·_meta 없는 업데이트는 채집하지 않는다", () => {
    const map = new Map<string, string>();
    recordToolName(map, { sessionUpdate: "agent_message_chunk", toolCallId: "t3" });
    recordToolName(map, { sessionUpdate: "tool_call", toolCallId: "t4", title: "Write" });
    expect(map.size).toBe(0);
  });

  it("채집 맵은 상한 초과 시 오래된 항목부터 제거한다", () => {
    const map = new Map<string, string>();
    for (let i = 0; i < 600; i++) {
      recordToolName(map, {
        sessionUpdate: "tool_call",
        toolCallId: `t${i}`,
        _meta: { claudeCode: { toolName: "Read" } },
      });
    }
    expect(map.size).toBeLessThanOrEqual(512);
    expect(map.has("t0")).toBe(false);
    expect(map.has("t599")).toBe(true);
  });
});

// B-3: 방어심화 하드-거부 — 티어 무관 즉시 거부(자동허용보다 먼저 평가)
describe("isHardDenied (방어심화 하드-거부)", () => {
  it("hard_deny 매칭 시 티어 무관 true", () => {
    expect(
      isHardDenied({ perm_tier: "acp", hard_deny: ["Bash(sudo *)"] }, "Bash", {
        command: "sudo rm",
      }),
    ).toBe(true);
    expect(
      isHardDenied({ perm_tier: "autopass", hard_deny: ["Bash(sudo *)"] }, "Bash", {
        command: "sudo rm",
      }),
    ).toBe(true);
  });

  it("매칭 안 되면 false(채널 승인·티어 로직으로)", () => {
    expect(
      isHardDenied({ perm_tier: "acp", hard_deny: ["Bash(sudo *)"] }, "Bash", { command: "ls" }),
    ).toBe(false);
    expect(isHardDenied({ perm_tier: "acp", hard_deny: [] }, "Bash", { command: "sudo rm" })).toBe(
      false,
    );
  });

  it("도구명 미해석(undefined)이면 판정 불가 → false", () => {
    expect(isHardDenied({ perm_tier: "acp", hard_deny: ["Bash"] }, undefined)).toBe(false);
  });

  it("hard_deny 미지정이면 false(기본 동작 불변)", () => {
    expect(isHardDenied({ perm_tier: "acp" }, "Bash", { command: "sudo rm" })).toBe(false);
  });
});

// 권한 결정 순서 SoT — hard-deny 가 자동허용(allowlist/autopass)보다 먼저 평가됨을 고정.
// 이 순서가 게이트의 보안 핵심이며, resolvePermDecision 이 requestPermission 클로저의 유일한 결정 경로다.
describe("resolvePermDecision — fail-closed 결정 순서", () => {
  it("allowlist 와 hard_deny 에 모두 있는 도구는 하드-거부가 이긴다(자동승인 안 됨)", () => {
    // 순서 회귀(자동허용을 먼저 평가) 시 이 도구가 auto:allowlist 로 새므로, 이 단언이 회귀를 잡는다.
    const decision = resolvePermDecision(
      { perm_tier: "acp", allowlist: ["Bash"], hard_deny: ["Bash(sudo *)"] },
      "Bash",
      { command: "sudo rm -rf /" },
    );
    expect(decision).toEqual({ kind: "hard_deny" });
  });

  it("autopass + hard_deny 도구는 denylist 폴백이 아니라 즉시 거부", () => {
    const decision = resolvePermDecision(
      { perm_tier: "autopass", hard_deny: ["Bash(sudo *)"] },
      "Bash",
      { command: "cd /tmp && sudo reboot" }, // 체이닝도 하드-거부로 잡힘
    );
    expect(decision).toEqual({ kind: "hard_deny" });
  });

  it("hard_deny 무매칭 + allowlist 매칭이면 auto:allowlist", () => {
    expect(
      resolvePermDecision({ perm_tier: "acp", allowlist: ["Read"] }, "Read", { file_path: "/x" }),
    ).toEqual({ kind: "auto", via: "allowlist" });
  });

  it("autopass + denylist 무매칭이면 auto:autopass", () => {
    expect(
      resolvePermDecision({ perm_tier: "autopass", denylist: ["Bash(sudo *)"] }, "Read", {
        file_path: "/x",
      }),
    ).toEqual({ kind: "auto", via: "autopass" });
  });

  it("autopass + denylist 매칭이면 채널 승인(ask)", () => {
    expect(
      resolvePermDecision({ perm_tier: "autopass", denylist: ["Bash(sudo *)"] }, "Bash", {
        command: "sudo rm",
      }),
    ).toEqual({ kind: "ask" });
  });

  it("도구명 미해석(undefined)이면 자동허용/하드거부 판정 불가 → ask(fail-closed)", () => {
    expect(
      resolvePermDecision(
        { perm_tier: "autopass", allowlist: ["Bash"], hard_deny: ["Bash"] },
        undefined,
      ),
    ).toEqual({ kind: "ask" });
  });
});

// 006 DEC-001/003: decideAutoAllow 가 rawInput 패턴 매칭을 반영한다
describe("decideAutoAllow — denylist 패턴 (006)", () => {
  const policy = {
    perm_tier: "autopass",
    denylist: ["Bash(git push --force*)", "Read(~/.ssh/**)"],
  };

  it("패턴 매칭 명령은 채널 승인 폴백, 비매칭은 자동 허용", () => {
    expect(decideAutoAllow(policy, "Bash", { command: "git push --force origin" })).toBeNull();
    expect(decideAutoAllow(policy, "Bash", { command: "git push origin" })).toBe("autopass");
  });

  it("패턴 항목인데 rawInput 이 없으면 채널 승인 폴백 (fail-closed)", () => {
    expect(decideAutoAllow(policy, "Bash", undefined)).toBeNull();
    expect(decideAutoAllow(policy, "Read", undefined)).toBeNull();
    // denylist 에 없는 도구는 인자 무관 자동 허용
    expect(decideAutoAllow(policy, "Write", undefined)).toBe("autopass");
  });
});

// F4/F8: requestPermission 배선 통합 — launch 클로저에서 분리한 extractPermDecision 을
// 실제 어댑터(claude-agent-acp) payload 형태로 검증한다. 단위 함수 조합만으론 못 잡는
// "필드 경로 배선"(toolCall.title 은 표시용·매칭 키 아님 / toolCall.rawInput 은 denylist 인자 매칭 /
// 도구명은 tool_call _meta.claudeCode.toolName 채집)이 게이트 결정으로 올바로 이어지는지 회귀 보호.
describe("extractPermDecision — requestPermission 배선 통합 (F4)", () => {
  /** 실제 requestPermission params 형태(sessionId·toolCall·options)로 조립. */
  function permParams(toolCall: Record<string, unknown>): RequestPermissionRequest {
    return {
      sessionId: "s1",
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    } as unknown as RequestPermissionRequest;
  }

  it("tool_call 채집 → title 아닌 원시 도구명·rawInput 추출 후 결정까지 통합", () => {
    const toolNames = new Map<string, string>();
    // 신규 어댑터 tool_call 업데이트 형태(_meta.claudeCode.toolName)로 도구명 채집
    recordToolName(toolNames, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "`sudo rm -rf /`",
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    // requestPermission 은 인자 포함 title + rawInput 만 담아 온다
    const params = permParams({
      toolCallId: "t1",
      title: "`sudo rm -rf /`",
      rawInput: { command: "sudo rm -rf /" },
    });
    const r = extractPermDecision(params, toolNames, {
      perm_tier: "autopass",
      denylist: ["Bash(sudo *)"],
    });
    expect(r.rawToolName).toBe("Bash"); // title 이 아니라 채집 도구명
    expect(r.rawInput).toEqual({ command: "sudo rm -rf /" }); // rawInput 필드 경로 배선
    expect(r.decision).toEqual({ kind: "ask" }); // denylist 매칭(rawInput 경유) → 채널 승인 폴백
  });

  it("title 은 매칭 키가 아니다 — 무서운 title 이어도 도구명(Read)으로 판정", () => {
    const toolNames = new Map<string, string>();
    recordToolName(toolNames, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      _meta: { claudeCode: { toolName: "Read" } },
    });
    const params = permParams({
      toolCallId: "t2",
      title: "`sudo rm`",
      rawInput: { file_path: "/x" },
    });
    const r = extractPermDecision(params, toolNames, {
      perm_tier: "autopass",
      denylist: ["Bash(sudo *)"],
    });
    expect(r.rawToolName).toBe("Read");
    expect(r.decision).toEqual({ kind: "auto", via: "autopass" }); // Read 는 denylist 밖 → 자동 허용
  });

  it("hard_deny 는 rawInput(체이닝 명령) 경유로 티어 무관 즉시 거부", () => {
    const toolNames = new Map<string, string>();
    recordToolName(toolNames, {
      sessionUpdate: "tool_call",
      toolCallId: "t3",
      _meta: { claudeCode: { toolName: "Bash" } },
    });
    const params = permParams({
      toolCallId: "t3",
      title: "`cd /tmp && sudo reboot`",
      rawInput: { command: "cd /tmp && sudo reboot" },
    });
    const r = extractPermDecision(params, toolNames, {
      perm_tier: "acp",
      hard_deny: ["Bash(sudo *)"],
    });
    expect(r.decision).toEqual({ kind: "hard_deny" });
  });

  it("도구명 미해석(채집 맵·_meta 부재) → ask (fail-closed)", () => {
    const params = permParams({ toolCallId: "unknown", title: "Write /etc/x", rawInput: {} });
    const r = extractPermDecision(params, new Map(), {
      perm_tier: "autopass",
      allowlist: ["Write"],
      denylist: [],
    });
    expect(r.rawToolName).toBeUndefined();
    expect(r.decision).toEqual({ kind: "ask" });
  });

  it("title 부재 시 표시 제목은 'unknown', allowlist 도구는 자동 허용", () => {
    const toolNames = new Map<string, string>();
    recordToolName(toolNames, {
      sessionUpdate: "tool_call",
      toolCallId: "t4",
      _meta: { claudeCode: { toolName: "Read" } },
    });
    const params = permParams({ toolCallId: "t4", rawInput: { file_path: "/x" } });
    const r = extractPermDecision(params, toolNames, { perm_tier: "acp", allowlist: ["Read"] });
    expect(r.toolTitle).toBe("unknown");
    expect(r.decision).toEqual({ kind: "auto", via: "allowlist" });
  });
});
