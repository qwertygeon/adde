import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-013(FR-007, [env:static]) — 007 inbox-zoned-layout 문서 계약 검증. 산출 주체는 T-C4(4단계
// Development 의 Layer C, 문서는 코드가 아니라 §해당 FR 이 명시적으로 문서를 산출물로 요구하는
// 예외 태스크)이며 PPG-1 병렬 중에는 아직 미착지가 예상 상태(RED) — main 이 T-C4 착지 후 이
// 파일만 재확인한다(PROC-R15/PROC-R17 순서 유예 관례, changelog-behavior-change.test.ts 와 동일 패턴).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const docs = [
  { label: "en", file: path.join(repoRoot, "docs", "markdown.md") },
  { label: "ko", file: path.join(repoRoot, "docs", "markdown.ko.md") },
];

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("SC-013: docs/markdown.md(·ko) 존 레이아웃 계약·예시 반영", () => {
  it("새 레이아웃 예시(팔레트·compose 센티널·기록 존 앵커)가 리터럴로 존재한다", () => {
    for (const { label, file } of docs) {
      const content = readIfExists(file);
      expect(content.length, `${label}: 문서 파일이 비어있거나 없음(${file})`).toBeGreaterThan(0);
      expect(content, `${label}: compose 센티널 리터럴 누락`).toContain("adde:compose");
      expect(content, `${label}: records 앵커 리터럴 누락`).toContain("adde:records");
      // 팔레트 4종 라벨(archive·clear·compact·resume)이 예시에 함께 등장.
      for (const label2 of ["archive", "clear", "compact", "resume"]) {
        expect(content, `${label}: 팔레트 라벨 '${label2}' 예시 누락`).toMatch(
          new RegExp(label2, "i"),
        );
      }
    }
  });

  it("기록 존 삭제 자유 계약과 유일 예외(⏳ sending)가 명시되어 있다", () => {
    for (const { label, file } of docs) {
      const content = readIfExists(file);
      // "삭제해도 된다/free to delete" 류 서술과 "sending" 예외가 같은 문서 내에 함께 존재하는지로
      // 판정(정확한 문장 형태는 6단계 Docs 재량 — 계약의 두 요소가 함께 언급되는지만 확인).
      const mentionsDeletionFreedom = /(삭제|delete|remove)/i.test(content);
      const mentionsSendingException = /sending/i.test(content);
      expect(
        mentionsDeletionFreedom && mentionsSendingException,
        `${label}: 기록 존 삭제 자유 계약·⏳ sending 유일 예외 서술을 찾을 수 없음`,
      ).toBe(true);
    }
  });

  it("레거시 마커 줄(`sent <id>`·기존 `archived N`)은 사용자 책임임을 명시한다", () => {
    for (const { label, file } of docs) {
      const content = readIfExists(file);
      const mentionsLegacy = /(레거시|legacy)/i.test(content);
      const mentionsUserResponsibility = /(사용자.*(책임|직접)|your.*(own|responsibility)|manually)/i.test(
        content,
      );
      expect(
        mentionsLegacy && mentionsUserResponsibility,
        `${label}: 레거시 줄 사용자 책임 서술을 찾을 수 없음`,
      ).toBe(true);
    }
  });
});
