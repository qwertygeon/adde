import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  parseDenyEntry,
  matchesDenylist,
  DEFAULT_AUTOPASS_DENYLIST,
} from "../../src/shared/deny-match.js";

// 006 DEC-001/002/003: Tool(glob) 패턴 매칭 — 판단 불가는 매칭(fail-closed=채널 승인 폴백)

describe("parseDenyEntry (DEC-001)", () => {
  it("도구명 단독과 Tool(glob) 을 파싱한다", () => {
    expect(parseDenyEntry("Bash")).toEqual({ tool: "Bash" });
    expect(parseDenyEntry("Bash(git push*)")).toEqual({ tool: "Bash", glob: "git push*" });
    expect(parseDenyEntry("Read(~/.ssh/**)")).toEqual({ tool: "Read", glob: "~/.ssh/**" });
  });

  it("형식 위반은 null", () => {
    expect(parseDenyEntry("Bash(")).toBeNull();
    expect(parseDenyEntry("(x)")).toBeNull();
    expect(parseDenyEntry("")).toBeNull();
    expect(parseDenyEntry("Ba sh(x)")).toBeNull();
  });
});

describe("matchesDenylist — 글롭 의미론 (DEC-001/003)", () => {
  it("도구명 단독 항목은 그 도구 전체를 매칭한다 (하위호환)", () => {
    expect(matchesDenylist(["Bash"], "Bash", { command: "ls" })).toBe(true);
    expect(matchesDenylist(["Bash"], "Read", { file_path: "/x" })).toBe(false);
  });

  it("전체 문자열 앵커 — 접두 매칭은 후행 * 로 명시한다", () => {
    expect(matchesDenylist(["Bash(git push*)"], "Bash", { command: "git push origin" })).toBe(true);
    expect(matchesDenylist(["Bash(git push*)"], "Bash", { command: "git pushX" })).toBe(true);
    expect(matchesDenylist(["Bash(git push)"], "Bash", { command: "git push origin" })).toBe(false);
    expect(matchesDenylist(["Bash(git push*)"], "Bash", { command: "echo git push" })).toBe(false);
  });

  it("중간 매칭은 *…* 로 — 어디에 있든 sudo 포함 차단", () => {
    expect(matchesDenylist(["Bash(*sudo *)"], "Bash", { command: "echo hi && sudo rm x" })).toBe(
      true,
    );
  });

  it("체이닝된 하위 명령을 세그먼트별로 잡는다 — 접두앵커 우회 차단", () => {
    // 앵커 글롭 Bash(sudo *)=^sudo .*$ 가 전체 문자열만 보면 놓치던 케이스들.
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "cd /tmp && sudo rm -rf /" })).toBe(
      true,
    );
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "x; sudo reboot" })).toBe(true);
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "cat f | sudo tee /etc/x" })).toBe(
      true,
    );
    // 선행 환경변수 대입 제거 후 매칭.
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "FOO=1 sudo make" })).toBe(true);
    // 명령치환 안의 위험 명령도 세그먼트로 노출.
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "echo $(sudo id)" })).toBe(true);
    // 서브셸·브레이스 그룹의 하위 명령도 분해된다(그룹 경계 (){}).
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "(sudo rm -rf /)" })).toBe(true);
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "{ sudo rm -rf /; }" })).toBe(true);
    expect(
      matchesDenylist(["Bash(sudo *)"], "Bash", { command: "cat f | (sudo tee /etc/x)" }),
    ).toBe(true);
  });

  it("세그먼트 매칭이 무해한 문자열을 과오매칭하지 않는다", () => {
    // sudo 가 실행 토큰이 아니라 인용/인자로 등장하면 매칭 안 함(안전 방향 유지하되 상식적).
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: 'echo "run sudo later"' })).toBe(
      false,
    );
    expect(matchesDenylist(["Bash(sudo *)"], "Bash", { command: "grep sudo /var/log/x" })).toBe(
      false,
    );
  });

  it("* 는 경로 구분자를 포함해 매칭한다 (** 와 동일 — 과매칭=안전 방향)", () => {
    expect(matchesDenylist(["Read(/etc/*)"], "Read", { file_path: "/etc/nginx/conf" })).toBe(true);
  });

  it("선행 ~ 패턴은 홈 확장 변형(절대경로 인자)도 매칭한다", () => {
    const abs = `${homedir()}/.ssh/id_rsa`;
    expect(matchesDenylist(["Read(~/.ssh/**)"], "Read", { file_path: abs })).toBe(true);
    expect(matchesDenylist(["Read(~/.ssh/**)"], "Read", { file_path: "~/.ssh/id_rsa" })).toBe(true);
    expect(matchesDenylist(["Read(~/.ssh/**)"], "Read", { file_path: "/tmp/x" })).toBe(false);
  });

  it("판단 불가는 매칭 — 인자 부재·rawInput 부재·매핑 없는 도구의 패턴 (fail-closed)", () => {
    expect(matchesDenylist(["Bash(git push*)"], "Bash", {})).toBe(true);
    expect(matchesDenylist(["Bash(git push*)"], "Bash", undefined)).toBe(true);
    expect(matchesDenylist(["SomeMcpTool(x*)"], "SomeMcpTool", { a: 1 })).toBe(true);
  });

  it("파싱 불가 항목(손편집 오타)은 전 도구 매칭 — 자동 허용 구멍 대신 전량 채널 승인", () => {
    expect(matchesDenylist(["Bash("], "Read", { file_path: "/x" })).toBe(true);
  });

  it("빈/미지정 denylist 는 아무것도 매칭하지 않는다", () => {
    expect(matchesDenylist([], "Bash", { command: "sudo x" })).toBe(false);
    expect(matchesDenylist(undefined, "Bash", { command: "sudo x" })).toBe(false);
  });

  it("도구명 비교는 대소문자 무시 — 오타(bash)가 자동 허용 구멍이 되지 않는다", () => {
    expect(matchesDenylist(["bash(sudo *)"], "Bash", { command: "sudo x" })).toBe(true);
    expect(matchesDenylist(["BASH"], "Bash", { command: "ls" })).toBe(true);
  });

  it("정규식 메타문자는 리터럴로 취급된다 (인젝션 불가)", () => {
    expect(matchesDenylist(["Bash(a.b)"], "Bash", { command: "axb" })).toBe(false);
    expect(matchesDenylist(["Bash(a.b)"], "Bash", { command: "a.b" })).toBe(true);
    expect(matchesDenylist(["Read(/x[0-9]/*)"], "Read", { file_path: "/x5/f" })).toBe(false);
    expect(matchesDenylist(["Read(/x[0-9]/*)"], "Read", { file_path: "/x[0-9]/f" })).toBe(true);
  });

  it("도구별 대표 인자 — WebFetch=url, Write=file_path", () => {
    expect(
      matchesDenylist(["WebFetch(https://evil.*)"], "WebFetch", { url: "https://evil.io" }),
    ).toBe(true);
    expect(matchesDenylist(["Write(/etc/*)"], "Write", { file_path: "/etc/passwd" })).toBe(true);
    expect(matchesDenylist(["Write(/etc/*)"], "Write", { file_path: "/tmp/x" })).toBe(false);
  });
});

describe("재귀 rm 견고 매칭 — 플래그 형태 불문(-r·-R·-fr·-rfv·--recursive), 대상 스코프 유지", () => {
  const rm = ["Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(rm -rf .*)"];

  it("-f 없는 -r 도 잡는다 (이번 개선의 핵심)", () => {
    expect(matchesDenylist(rm, "Bash", { command: "rm -r /etc" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm -r ~/Documents" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm -r .git" })).toBe(true);
  });

  it("플래그 순서·번들·대문자·--recursive 변형을 잡는다", () => {
    expect(matchesDenylist(rm, "Bash", { command: "rm -fr /" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm -R /var" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm -rfv /" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm --recursive /etc" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "rm -rf  /" })).toBe(true); // 이중 공백
    expect(matchesDenylist(rm, "Bash", { command: 'rm -r "/"' })).toBe(true); // 인용 대상
  });

  it("체이닝·서브셸의 재귀 rm 도 세그먼트로 잡는다", () => {
    expect(matchesDenylist(rm, "Bash", { command: "cd /tmp && rm -r /etc" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "(rm -R ~/x)" })).toBe(true);
    expect(matchesDenylist(rm, "Bash", { command: "FOO=1 rm -r /var" })).toBe(true);
  });

  it("스코프 유지 — 비대상(상대경로) 재귀 rm 은 통과, 비재귀 rm 도 통과", () => {
    // 대상이 / ~ . 이 아니면(상대 하위경로) autopass 허용 유지(자율성).
    expect(matchesDenylist(rm, "Bash", { command: "rm -rf build" })).toBe(false);
    expect(matchesDenylist(rm, "Bash", { command: "rm -r node_modules" })).toBe(false);
    // 재귀 아님(-f 만·단일 파일)은 대상 무관 미매칭.
    expect(matchesDenylist(rm, "Bash", { command: "rm -f /etc/x" })).toBe(false);
    expect(matchesDenylist(rm, "Bash", { command: "rm /etc/x" })).toBe(false);
    // rm 이 실행 토큰이 아니면 미매칭.
    expect(matchesDenylist(rm, "Bash", { command: "echo rm -r /" })).toBe(false);
  });
});

describe("정규화 인식기 — 절대경로·래퍼·이중공백 우회 차단", () => {
  const D = [...DEFAULT_AUTOPASS_DENYLIST];
  const bash = (c: string) => matchesDenylist(D, "Bash", { command: c });

  it("절대경로·따옴표·백슬래시 명령도 잡는다 (rm)", () => {
    expect(bash("/bin/rm -rf /")).toBe(true);
    expect(bash("/usr/bin/rm -r ~/x")).toBe(true);
    expect(bash('"rm" -rf /')).toBe(true);
    expect(bash("\\rm -rf /")).toBe(true);
  });

  it("래퍼(env·nice·time·command)를 벗겨 실제 명령을 본다", () => {
    expect(bash("env rm -rf /")).toBe(true);
    expect(bash("env FOO=1 rm -rf /")).toBe(true);
    expect(bash("nice -n 10 rm -rf /")).toBe(true);
    expect(bash("time rm -rf /")).toBe(true);
    expect(bash("command rm -rf /")).toBe(true);
    expect(bash("/usr/bin/git push --force")).toBe(true);
  });
});

describe("정규화 인식기 — git 강제 변경 형태 불문", () => {
  const D = [...DEFAULT_AUTOPASS_DENYLIST];
  const bash = (c: string) => matchesDenylist(D, "Bash", { command: c });

  it("refspec + 강제푸시를 잡는다 (--force 미포함)", () => {
    expect(bash("git push origin +main")).toBe(true);
    expect(bash("git push origin +HEAD:main")).toBe(true);
  });

  it("전역옵션 -C/-c 접두를 무시하고 서브커맨드로 판정", () => {
    expect(bash("git -C /repo push --force")).toBe(true);
    expect(bash("git -C /repo reset --hard")).toBe(true);
    expect(bash("git -C /repo clean -fd")).toBe(true);
    expect(bash("git -c foo=bar push --force")).toBe(true);
  });

  it("이중공백·플래그순서·번들·--force-with-lease 변형", () => {
    expect(bash("git  push --force")).toBe(true);
    expect(bash("git clean -df")).toBe(true);
    expect(bash("git clean --force -d")).toBe(true);
    expect(bash("git push -uf origin")).toBe(true);
    expect(bash("git push --force-with-lease origin")).toBe(true);
    expect(bash("git clean -f")).toBe(true); // -d 없이 -f 만으로도 위험
  });

  it("비강제 git 은 통과 (자율성 유지)", () => {
    expect(bash("git push origin feature/x")).toBe(false);
    expect(bash("git status")).toBe(false);
    expect(bash("git reset HEAD~1")).toBe(false); // --hard 아님
    expect(bash("git clean -n")).toBe(false); // dry-run(-n)만
  });
});

describe("정규화 인식기 — 권한상승 doas", () => {
  const D = [...DEFAULT_AUTOPASS_DENYLIST];
  it("doas·경로 doas 를 잡는다", () => {
    expect(matchesDenylist(D, "Bash", { command: "doas rm -rf /" })).toBe(true);
    expect(matchesDenylist(D, "Bash", { command: "/usr/bin/doas reboot" })).toBe(true);
    expect(matchesDenylist(D, "Bash", { command: "env sudo make" })).toBe(true);
  });
});

describe("자격증명 경로 교차 보호 — 파일도구 전반 + Bash args", () => {
  const D = [...DEFAULT_AUTOPASS_DENYLIST];

  it("Bash 리더(cat/cp/less)가 자격증명 경로를 건드리면 잡는다", () => {
    expect(matchesDenylist(D, "Bash", { command: "cat ~/.ssh/id_rsa" })).toBe(true);
    expect(matchesDenylist(D, "Bash", { command: "cp ~/.aws/credentials /tmp/x" })).toBe(true);
    expect(matchesDenylist(D, "Bash", { command: "less ~/.config/gh/hosts.yml" })).toBe(true);
  });

  it("Write/Edit/NotebookEdit 로 자격증명 경로 쓰기도 잡는다 (Read 전용 아님)", () => {
    expect(matchesDenylist(D, "Write", { file_path: `${homedir()}/.ssh/authorized_keys` })).toBe(
      true,
    );
    expect(matchesDenylist(D, "Edit", { file_path: "~/.aws/credentials" })).toBe(true);
  });

  it("경로 트래버설(..)을 접어서 잡는다", () => {
    expect(matchesDenylist(D, "Read", { file_path: "~/x/../.ssh/id_rsa" })).toBe(true);
    expect(matchesDenylist(D, "Bash", { command: "cat ~/x/../.ssh/id_rsa" })).toBe(true);
  });

  it("비자격증명 경로는 통과", () => {
    expect(matchesDenylist(D, "Write", { file_path: "/tmp/out.txt" })).toBe(false);
    expect(matchesDenylist(D, "Bash", { command: "cat README.md" })).toBe(false);
  });
});

describe("DEFAULT_AUTOPASS_DENYLIST — 내장 기본 denylist", () => {
  it("전 항목이 유효한 형식이다", () => {
    for (const entry of DEFAULT_AUTOPASS_DENYLIST) {
      expect(parseDenyEntry(entry)).not.toBeNull();
      expect(entry).not.toContain(",");
    }
  });

  it("대표 위험 명령·경로를 매칭한다", () => {
    const list = [...DEFAULT_AUTOPASS_DENYLIST];
    expect(matchesDenylist(list, "Bash", { command: "sudo rm -rf /" })).toBe(true);
    expect(matchesDenylist(list, "Bash", { command: "git push --force origin main" })).toBe(true);
    expect(matchesDenylist(list, "Bash", { command: "git reset --hard HEAD~1" })).toBe(true);
    expect(matchesDenylist(list, "Bash", { command: "git clean -fdx" })).toBe(true);
    // 체이닝된 위험 명령도 기본 목록이 잡는다.
    expect(matchesDenylist(list, "Bash", { command: "cd /repo && git reset --hard HEAD" })).toBe(
      true,
    );
    expect(matchesDenylist(list, "Bash", { command: "make && sudo rm -rf /" })).toBe(true);
    expect(matchesDenylist(list, "Read", { file_path: `${homedir()}/.ssh/id_rsa` })).toBe(true);
    // 일반 작업은 통과(자동 허용 대상)
    expect(matchesDenylist(list, "Bash", { command: "git push origin feature/x" })).toBe(false);
    expect(matchesDenylist(list, "Bash", { command: "pnpm test" })).toBe(false);
    expect(matchesDenylist(list, "Write", { file_path: "/tmp/out.txt" })).toBe(false);
  });
});
