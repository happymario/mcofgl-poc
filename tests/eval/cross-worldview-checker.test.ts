// F-001 Task 8 — cross-worldview-checker 계약 테스트.
//
// 검증 책임:
// - 상대 세계관의 tone.forbidden 키워드가 텍스트에 등장하면 leaked에 포함
// - 오염이 없으면 leaked=[]
// - 동일 단어가 여러 번 등장해도 leaked는 유니크
// - 동일 세계관(id 일치)끼리 비교하면 자기 자신 비교이므로 leaked=[]로 단락(short-circuit)

import { describe, expect, it } from "vitest";
import type { WorldviewBible } from "../../src/core/schemas/worldview.js";
import { detectCrossContamination } from "../../src/eval/cross-worldview-checker.js";

const LIGHT_BIBLE: WorldviewBible = {
  id: "kingdom_of_light",
  background: "빛의 왕국",
  tone: {
    keywords: ["용사", "서약", "가호"],
    forbidden: ["기숙사", "교복", "사물함"],
    examples: [],
  },
  vocabulary: { 집: "길드 기지" },
  npcs: [],
  few_shots: [],
};

const ACADEMY_BIBLE: WorldviewBible = {
  id: "magic_academy",
  background: "마법 학원",
  tone: {
    keywords: ["학원", "교복", "기숙사"],
    forbidden: ["용사", "서약"],
    examples: [],
  },
  vocabulary: { 집: "기숙사" },
  npcs: [],
  few_shots: [],
};

describe("detectCrossContamination", () => {
  it("오염이 없으면 leaked=[]를 반환한다", () => {
    const result = detectCrossContamination(
      "마법 학원의 일상은 평온했다",
      ACADEMY_BIBLE,
      LIGHT_BIBLE,
    );
    expect(result.leaked).toEqual([]);
  });

  it("상대 바이블의 forbidden 단어가 텍스트에 등장하면 leaked에 추가된다", () => {
    // ACADEMY 퀘스트인데 LIGHT의 금지어('기숙사', '교복')가 등장 → 오염
    const result = detectCrossContamination(
      "용사여, 기숙사를 떠나 교복을 벗어던져라",
      ACADEMY_BIBLE,
      LIGHT_BIBLE,
    );
    expect(result.leaked).toEqual(
      expect.arrayContaining(["기숙사", "교복"]),
    );
    expect(result.leaked).not.toContain("사물함");
    expect(result.leaked).toHaveLength(2);
  });

  it("동일 단어가 여러 번 등장해도 leaked는 유니크", () => {
    const result = detectCrossContamination(
      "기숙사, 기숙사, 또 기숙사.",
      ACADEMY_BIBLE,
      LIGHT_BIBLE,
    );
    expect(result.leaked).toEqual(["기숙사"]);
  });

  it("자기 자신과 비교(id 일치)하면 오염으로 간주하지 않는다", () => {
    // LIGHT_BIBLE의 forbidden에 '기숙사'가 있지만
    // ownBible=otherBible=LIGHT일 때는 오염이 아니라고 본다.
    const result = detectCrossContamination(
      "기숙사라는 단어가 섞여 있다",
      LIGHT_BIBLE,
      LIGHT_BIBLE,
    );
    expect(result.leaked).toEqual([]);
  });

  it("대소문자를 구분하지 않는다", () => {
    const ENGLISH_OTHER: WorldviewBible = {
      ...LIGHT_BIBLE,
      id: "english_realm",
      tone: { keywords: [], forbidden: ["Dormitory"], examples: [] },
    };
    const result = detectCrossContamination(
      "I went to the DORMITORY last night",
      ACADEMY_BIBLE,
      ENGLISH_OTHER,
    );
    expect(result.leaked).toEqual(["Dormitory"]);
  });
});
