// 스펙 §F-003 — RuleFilter 계약 테스트.
//
// RuleFilter는 quest_name + description 텍스트에 대해 카테고리별 키워드/정규식을
// 매칭해 다음 3종의 verdict 중 하나를 반환한다.
//
// - `block_and_fallback` — 금칙 키워드/패턴 히트
// - `replaced`            — replace 카테고리 적용 후 잔여 금칙 키워드 없음
// - `pass`                — 아무 룰도 히트하지 않음
//
// 주요 규칙:
// 1) 검사 대상은 `quest_name + "\n" + description` 합본.
// 2) allowlist 항목은 검사 텍스트에서 먼저 제거(빈 문자열 치환)되어 무시된다.
// 3) replace 액션은 description만 치환하며, 치환 후 잔여 차단 키워드가 있으면
//    최종 verdict는 block_and_fallback으로 격상된다.
// 4) latency_ms는 항상 숫자 (>=0).

import { describe, expect, it } from "vitest";
import { RuleFilter } from "../../../src/core/safety/rule-filter.js";
import type { SafetyRules } from "../../../src/core/safety/schemas.js";
import type { Quest } from "../../../src/core/schemas/quest.js";

// 테스트용 Quest 팩토리 — 필수 필드 9개를 한번에 주입하고, 테스트별로는
// quest_name / description만 override한다.
function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    quest_name: "기본 퀘스트",
    description: "기본 설명",
    category: "학습",
    stat_mapping: { 지혜: 1 },
    reward: { exp: 10, coin: 5 },
    suggested_grade: "D",
    mandatory_suitability: "medium",
    original_habit: "숙제하기",
    worldview_id: "fantasy_v1",
    ...overrides,
  };
}

// 테스트용 룰 픽스처 — 인라인 객체로 실제 SafetyRules 구조를 그대로 사용.
const testRules: SafetyRules = {
  categories: {
    violence: {
      keywords: ["살인", "죽여"],
      patterns: ["\\d+명.*죽"],
      action: "block_and_fallback",
    },
    tone: {
      keywords: ["슬픈"],
      action: "replace",
      replacements: { 슬픈: "즐거운" },
    },
  },
  allowlist: ["어둠의 안개", "어둠"],
};

describe("RuleFilter.check", () => {
  it("1) block_and_fallback 키워드가 quest_name에 히트하면 차단한다", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "살인 퀘스트",
      description: "평범한 설명",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("block_and_fallback");
    expect(result.category).toBe("violence");
    expect(result.matches).toContain("살인");
  });

  it("2) 정규식 패턴이 description에 히트하면 차단한다", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "무해한 이름",
      description: "3명이 죽는 장면을 떠올리자",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("block_and_fallback");
    expect(result.category).toBe("violence");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("3) replace 키워드가 히트하면 description을 치환하고 replaced를 반환한다", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "이야기 듣기",
      description: "슬픈 이야기를 들어보자",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("replaced");
    expect(result.replacedQuest).toBeDefined();
    expect(result.replacedQuest?.description).toContain("즐거운 이야기");
    expect(result.replacedQuest?.description).not.toContain("슬픈");
    expect(result.matches).toContain("슬픈");
  });

  it("4) replace 후에도 잔여 차단 키워드가 있으면 block_and_fallback으로 격상한다", () => {
    const filter = new RuleFilter(testRules);
    // "슬픈"은 replace 대상이지만 "살인"이 남아 있어 최종 차단되어야 함.
    const quest = makeQuest({
      quest_name: "혼합 퀘스트",
      description: "슬픈 살인 이야기",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("block_and_fallback");
    expect(result.category).toBe("violence");
    expect(result.matches).toContain("살인");
  });

  it("5) allowlist에 있는 RPG 표준 어휘는 pass된다", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "어둠의 안개를 물리쳐라",
      description: "용사가 어둠을 헤쳐나간다",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("pass");
  });

  it("6) 평범한 습관 퀘스트는 pass, matches는 빈 배열이다", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "아침 일찍 일어나기",
      description: "알람을 듣고 7시에 기상한다",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("pass");
    expect(result.matches).toEqual([]);
  });

  it("7) 모든 결과에 latency_ms가 숫자로 설정된다", () => {
    const filter = new RuleFilter(testRules);

    const passResult = filter.check(
      makeQuest({ quest_name: "평범한 할 일", description: "숙제하기" }),
    );
    const blockResult = filter.check(
      makeQuest({ quest_name: "살인 퀘스트", description: "금지" }),
    );
    const replaceResult = filter.check(
      makeQuest({ quest_name: "이야기", description: "슬픈 이야기" }),
    );

    for (const r of [passResult, blockResult, replaceResult]) {
      expect(typeof r.latency_ms).toBe("number");
      expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("9) reward.buff에만 차단 키워드가 있으면 block_and_fallback", () => {
    const filter = new RuleFilter(testRules);
    const quest = makeQuest({
      quest_name: "아침 운동",
      description: "건강한 아침을 시작한다",
      reward: { exp: 10, coin: 5, buff: "살인의 기운 +1" },
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("block_and_fallback");
    expect(result.category).toBe("violence");
  });

  // 추가 검증: allowlist stripping 로직이 실제로 키워드 매칭을 제거하는지 확인.
  // testRules의 "어둠"은 카테고리 키워드가 아니므로 기본 케이스 5만으로는 allowlist
  // stripping 경로를 증명하지 못한다. 아래 보강 테스트는 allowlist 항목을 동시에
  // block 키워드로 등록해 stripping이 실제로 동작하는지 실증한다.
  it("8) allowlist는 키워드/패턴 매칭을 실제로 제거한다", () => {
    const augmentedRules: SafetyRules = {
      categories: {
        violence: {
          keywords: ["살인", "죽여", "어둠"],
          action: "block_and_fallback",
        },
      },
      allowlist: ["어둠의 안개", "어둠"],
    };
    const filter = new RuleFilter(augmentedRules);

    // "어둠"은 block 키워드이지만 allowlist에도 있어 무시된다.
    const quest = makeQuest({
      quest_name: "어둠의 안개를 물리쳐라",
      description: "어둠을 헤쳐나간다",
    });

    const result = filter.check(quest);

    expect(result.verdict).toBe("pass");
    expect(result.matches).toEqual([]);
  });
});
