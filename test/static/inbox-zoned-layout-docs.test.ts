import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_SENTINEL,
  RECORDS_ANCHOR,
  paletteLines,
} from "../../src/src-adapters/markdown.js";
import { en } from "../../src/shared/locales/en.js";
import { ko } from "../../src/shared/locales/ko.js";

// SC-013(FR-007, [env:static]) — 007 inbox-zoned-layout 문서 계약 검증. 산출 주체는 T-C4(4단계
// Development 의 Layer C, 문서는 코드가 아니라 §해당 FR 이 명시적으로 문서를 산출물로 요구하는
// 예외 태스크)이며 PPG-1 병렬 중에는 아직 미착지가 예상 상태(RED) — main 이 T-C4 착지 후 이
// 파일만 재확인한다(PROC-R15/PROC-R17 순서 유예 관례, changelog-behavior-change.test.ts 와 동일 패턴).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const docs = [
  { label: "en", file: path.join(repoRoot, "docs", "markdown.md"), recordsHeading: en.markdown.recordsHeading },
  { label: "ko", file: path.join(repoRoot, "docs", "markdown.ko.md"), recordsHeading: ko.markdown.recordsHeading },
];
const commandDocs = [
  { label: "en", file: path.join(repoRoot, "docs", "commands.md") },
  { label: "ko", file: path.join(repoRoot, "docs", "commands.ko.md") },
];

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("SC-013: docs/markdown.md(·ko) 존 레이아웃 계약·예시 반영", () => {
  it("새 레이아웃 예시 리터럴(compose 센티널·records 앵커·기록 헤딩)이 구현 상수와 정확 일치한다", () => {
    for (const { label, file, recordsHeading } of docs) {
      const content = readIfExists(file);
      expect(content.length, `${label}: 문서 파일이 비어있거나 없음(${file})`).toBeGreaterThan(0);
      // 정확 문자열 고정 — 구현 상수가 바뀌면 문서 예시도 함께 갱신되도록(드리프트 차단).
      expect(content, `${label}: compose 센티널 정확 리터럴 누락`).toContain(COMPOSE_SENTINEL);
      expect(content, `${label}: records 앵커 정확 리터럴 누락`).toContain(RECORDS_ANCHOR);
      expect(content, `${label}: 기록 존 헤딩(## ${recordsHeading}) 누락`).toContain(
        `## ${recordsHeading}`,
      );
    }
  });

  it("팔레트 4종 라인이 구현 paletteLines() 정확 형식(체크박스·이모지·라벨)으로 예시에 존재한다", () => {
    for (const { label, file } of docs) {
      const content = readIfExists(file);
      // substring 매칭이 아니라 paletteLines() 리터럴 전체(`- [ ] 🗄️ archive` 등)를 그대로 대조 —
      // 라벨 단어만 있고 체크박스·이모지 형식이 어긋나는 드리프트를 잡는다.
      for (const line of paletteLines()) {
        expect(content, `${label}: 팔레트 라인 '${line}' 정확 리터럴 누락`).toContain(line);
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

describe("SC-013: docs/commands.md(·ko) 세션 제어 종단 서술이 layout-on 미체크 복원 계약을 반영한다", () => {
  it("팔레트 제어 라벨이 layout-on 에서 미체크 복원됨을 서술한다(무조건 ✅ sent 종단 서술 아님)", () => {
    for (const { label, file } of commandDocs) {
      const content = readIfExists(file);
      expect(content.length, `${label}: 문서 파일이 비어있거나 없음(${file})`).toBeGreaterThan(0);
      // layout-on(기본)에서 제어 마커는 종단이 아니라 미체크 복원(팔레트 상주 계약, markdown.ts
      // controlFinalized → uncheckLine). 문서가 이 조건 동작을 서술하는지 확인.
      const mentionsRestore = /(미체크로 복원|restored to unchecked)/i.test(content);
      expect(
        mentionsRestore,
        `${label}: 세션 제어 라벨의 layout-on 미체크 복원 서술을 찾을 수 없음(commands 문서)`,
      ).toBe(true);
    }
  });
});
