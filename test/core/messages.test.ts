import { beforeAll, describe, expect, it } from "vitest";
import {
  COMMANDS,
  buildUsage,
  USAGE,
  buildGroupUsage,
  cmdError,
  groupError,
  unknownGroupSub,
} from "../../src/core/messages.js";
import { setLocale } from "../../src/shared/i18n.js";

// messages.ts 가 CLI 사용자 노출 문자열의 SoT (문구 본문은 i18n 카탈로그 소유).
// 문구 어서션은 로케일 의존 → ko 고정 후 검증(실행 환경 LANG 비의존).
// 실측(v2): 명령 그룹 도움말·오류 빌더는 레인 전용 함수(buildLaneUsage/laneError/unknownLaneSub)
// 가 아니라 그룹 매개변수화된 buildGroupUsage(usageKey)/groupError(group,detail)/
// unknownGroupSub(group,sub,usageKey) 로 일반화되었다(project/session/bind/vault 공용).

beforeAll(() => setLocale("ko"));

describe("messages — 도움말/사용법 SoT", () => {
  it("buildUsage 는 명령 표면과 신규 명령(status/doctor/logs)을 노출한다", () => {
    const u = buildUsage();
    expect(u).toContain(COMMANDS.primary);
    expect(u).toContain(COMMANDS.short);
    // v2: 세션 축 표면(FR-030) — 최상위 명령에 "lane" 은 더 이상 존재하지 않고 project 로 대체.
    for (const cmd of ["status", "doctor", "logs", "up", "down", "project"]) {
      expect(u).toContain(cmd);
    }
  });

  it("USAGE 의 각 명령 사용법은 'adde' 로 시작한다(첫 줄 단일형 또는 그룹 나열형 2번째 줄)", () => {
    // 대부분 한 줄(`사용법: adde ...`). completion 은 왜/무엇/어디 설명을 담은 상세 블록이라
    // 여러 줄 허용(불변식은 '첫 줄이 사용법: adde 로 시작'). v2 명령 그룹(project/session/bind/
    // vault)은 서브커맨드를 여러 줄로 나열하는 형식이라 첫 줄이 "사용법:" 단독이고 그 다음 줄부터
    // "adde <그룹> <서브>..." 가 이어진다 — 두 형식 모두 허용한다.
    for (const usage of Object.values(USAGE)) {
      const lines = usage.split("\n");
      const firstLine = lines[0] ?? "";
      const singleForm = /^사용법: adde /.test(firstLine);
      const groupForm = firstLine === "사용법:" && /^\s*adde /.test(lines[1] ?? "");
      expect(singleForm || groupForm, `예상 밖 형식: ${JSON.stringify(lines.slice(0, 2))}`).toBe(
        true,
      );
    }
  });

  it("buildGroupUsage(usage.project) 는 project 서브커맨드를 모두 포함", () => {
    const projectUsage = buildGroupUsage("usage.project");
    for (const sub of ["project add", "project set", "project show", "project ls", "project rm"]) {
      expect(projectUsage).toContain(sub);
    }
  });
});

describe("messages — 오류 빌더", () => {
  it("cmdError 는 [adde <cmd>] 오류 형식", () => {
    expect(cmdError("up", "x 실패")).toBe("[adde up] 오류: x 실패");
  });

  it("groupError 는 [adde <group>] 접두(그룹 매개변수화 — cmdError 와 동일 템플릿 재사용)", () => {
    // 실측: groupError() 는 cmdError() 와 동일한 i18n 템플릿(cli.cmdError)을 그룹명으로 호출한다.
    expect(groupError("project", "이미 존재")).toBe(cmdError("project", "이미 존재"));
    expect(groupError("project", "이미 존재")).toContain("[adde project]");
  });

  it("unknownGroupSub 는 입력 서브커맨드와 해당 그룹의 사용법을 함께 안내", () => {
    const out = unknownGroupSub("project", "frob", "usage.project");
    expect(out).toContain("frob");
    expect(out).toContain("project add");
  });
});
