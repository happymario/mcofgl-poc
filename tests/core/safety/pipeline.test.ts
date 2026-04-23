// 스펙 §F-003 Task 6 — SafetyFilterPipeline 계약 테스트.
//
// RuleFilter → LlmVerifier → FallbackSelector 체인을 조립하고 최종
// `{ quest, filter_result }`를 반환하는 파이프라인의 행위를 고정한다.
//
// 분기 매트릭스 (assertion으로 고정):
//
// | RuleFilter verdict      | LlmVerifier | 최종 verdict | blocked | quest           | stage |
// |-------------------------|-------------|--------------|---------|-----------------|-------|
// | block_and_fallback      | (미호출)    | unsafe       | true    | fallbackQuest   | rule  |
// | replaced                | (미호출)    | replaced     | false   | replacedQuest   | rule  |
// | pass                    | safe        | safe         | false   | originalQuest   | llm   |
// | pass                    | unsafe      | unsafe       | true    | fallbackQuest   | llm   |
// | pass                    | borderline  | borderline   | true    | fallbackQuest   | llm   |
//
// 주요 규칙:
// 1) RuleFilter가 block_and_fallback이면 LlmVerifier는 호출되지 않는다(비용 절감).
// 2) RuleFilter가 replaced면 LlmVerifier는 호출되지 않는다(룰이 이미 안전 치환을 보장).
// 3) filter_result.latency_ms는 apply() 전체 지연 (performance.now 차분).
// 4) rule_latency_ms / llm_latency_ms는 각 단계 결과의 latency_ms를 passthrough.
// 5) LlmVerifier가 borderline이면 console.warn으로 모니터링용 로그를 남긴다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FallbackSelector } from "../../../src/core/safety/fallback-selector.js";
import type { LlmVerifier } from "../../../src/core/safety/llm-verifier.js";
import { SafetyFilterPipeline } from "../../../src/core/safety/pipeline.js";
import type { RuleFilter } from "../../../src/core/safety/rule-filter.js";
import type { Quest } from "../../../src/core/schemas/quest.js";

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
    worldview_id: "kingdom_of_light",
    ...overrides,
  };
}

function makeMocks() {
  const ruleCheck = vi.fn();
  const llmVerify = vi.fn();
  const fallbackSelect = vi.fn();

  const mockRuleFilter = { check: ruleCheck } as unknown as RuleFilter;
  const mockLlmVerifier = { verify: llmVerify } as unknown as LlmVerifier;
  const mockFallbackSelector = { select: fallbackSelect } as unknown as FallbackSelector;

  const pipeline = new SafetyFilterPipeline(
    mockRuleFilter,
    mockLlmVerifier,
    mockFallbackSelector,
  );

  return { pipeline, ruleCheck, llmVerify, fallbackSelect };
}

describe("SafetyFilterPipeline.apply", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("1) RuleFilter block → LlmVerifier 미호출 + FallbackSelector 호출 + blocked=true", async () => {
    const originalQuest = makeQuest({
      quest_name: "위험 퀘스트",
      description: "살인을 저지른다",
    });
    const fallbackQuest = makeQuest({ quest_name: "안전 폴백" });

    const { pipeline, ruleCheck, llmVerify, fallbackSelect } = makeMocks();

    ruleCheck.mockReturnValue({
      verdict: "block_and_fallback",
      matches: ["살인"],
      category: "violence",
      latency_ms: 1,
    });
    fallbackSelect.mockResolvedValue(fallbackQuest);

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    // LlmVerifier는 호출되지 않아야 한다(비용 절감).
    expect(llmVerify).toHaveBeenCalledTimes(0);
    // FallbackSelector는 명시된 파라미터로 1회 호출.
    expect(fallbackSelect).toHaveBeenCalledTimes(1);
    expect(fallbackSelect).toHaveBeenCalledWith({
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    // 폴백 퀘스트는 original_habit/worldview_id가 현재 요청값으로 오버라이드된 새 객체.
    expect(result.quest).toEqual({ ...fallbackQuest, original_habit: "아침 7시 기상", worldview_id: "kingdom_of_light" });
    expect(result.quest.original_habit).toBe("아침 7시 기상");
    expect(result.quest.worldview_id).toBe("kingdom_of_light");
    expect(result.filter_result.stage).toBe("rule");
    expect(result.filter_result.verdict).toBe("unsafe");
    expect(result.filter_result.blocked).toBe(true);
    // LLM 미호출이므로 llm_latency_ms는 없어야 한다.
    expect(result.filter_result.llm_latency_ms).toBeUndefined();
    // rule_latency_ms는 RuleFilter 결과에서 passthrough.
    expect(result.filter_result.rule_latency_ms).toBe(1);
  });

  it("2) RuleFilter replaced → LlmVerifier 미호출 + replacedQuest + verdict=replaced", async () => {
    const originalQuest = makeQuest({
      quest_name: "슬픈 아침",
      description: "슬픈 마음으로 일어난다",
    });
    const replacedQuest = makeQuest({
      quest_name: "슬픈 아침",
      description: "즐거운 마음으로 일어난다",
    });

    const { pipeline, ruleCheck, llmVerify, fallbackSelect } = makeMocks();

    ruleCheck.mockReturnValue({
      verdict: "replaced",
      matches: ["슬픈"],
      replacedQuest,
      latency_ms: 1,
    });

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    // 룰 치환만으로 안전이 보장되므로 LlmVerifier는 호출되지 않는다(비용 절감).
    expect(llmVerify).toHaveBeenCalledTimes(0);
    expect(fallbackSelect).toHaveBeenCalledTimes(0);

    // F-001 계약: original_habit/worldview_id는 요청값으로 강제 주입된다.
    expect(result.quest).toEqual({
      ...replacedQuest,
      original_habit: "아침 7시 기상",
      worldview_id: "kingdom_of_light",
    });
    expect(result.filter_result.stage).toBe("rule");
    expect(result.filter_result.verdict).toBe("replaced");
    expect(result.filter_result.blocked).toBe(false);
    expect(result.filter_result.rule_latency_ms).toBe(1);
    // LLM 미호출이므로 llm_latency_ms는 없어야 한다.
    expect(result.filter_result.llm_latency_ms).toBeUndefined();
  });

  it("3) RuleFilter pass + LlmVerifier safe → 원본 quest + blocked=false", async () => {
    const originalQuest = makeQuest({
      quest_name: "아침 의식",
      description: "아침 7시에 일어난다",
    });

    const { pipeline, ruleCheck, llmVerify, fallbackSelect } = makeMocks();

    ruleCheck.mockReturnValue({ verdict: "pass", matches: [], latency_ms: 1 });
    llmVerify.mockResolvedValue({ verdict: "safe", latency_ms: 50 });

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    expect(llmVerify).toHaveBeenCalledTimes(1);
    expect(llmVerify).toHaveBeenCalledWith(originalQuest, "7-12");
    expect(fallbackSelect).toHaveBeenCalledTimes(0);

    // F-001 계약: original_habit/worldview_id는 요청값으로 강제 주입된다.
    expect(result.quest).toEqual({
      ...originalQuest,
      original_habit: "아침 7시 기상",
      worldview_id: "kingdom_of_light",
    });
    expect(result.filter_result.stage).toBe("llm");
    expect(result.filter_result.verdict).toBe("safe");
    expect(result.filter_result.blocked).toBe(false);
  });

  it("4) RuleFilter pass + LlmVerifier unsafe → fallback + verdict=unsafe + blocked=true", async () => {
    const originalQuest = makeQuest();
    const fallbackQuest = makeQuest({ quest_name: "안전 폴백" });

    const { pipeline, ruleCheck, llmVerify, fallbackSelect } = makeMocks();

    ruleCheck.mockReturnValue({ verdict: "pass", matches: [], latency_ms: 1 });
    llmVerify.mockResolvedValue({
      verdict: "unsafe",
      reason: "폭력 묘사",
      latency_ms: 50,
    });
    fallbackSelect.mockResolvedValue(fallbackQuest);

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "저녁 양치",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    expect(fallbackSelect).toHaveBeenCalledTimes(1);
    expect(fallbackSelect).toHaveBeenCalledWith({
      habitText: "저녁 양치",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    // 폴백 퀘스트는 original_habit/worldview_id가 현재 요청값으로 오버라이드된 새 객체.
    expect(result.quest.original_habit).toBe("저녁 양치");
    expect(result.quest.worldview_id).toBe("kingdom_of_light");
    expect(result.quest.quest_name).toBe("안전 폴백");
    expect(result.filter_result.stage).toBe("llm");
    expect(result.filter_result.verdict).toBe("unsafe");
    expect(result.filter_result.blocked).toBe(true);
  });

  it("5) RuleFilter pass + LlmVerifier borderline → fallback + verdict=borderline + console.warn", async () => {
    const originalQuest = makeQuest();
    const fallbackQuest = makeQuest({ quest_name: "안전 폴백" });

    const { pipeline, ruleCheck, llmVerify, fallbackSelect } = makeMocks();

    ruleCheck.mockReturnValue({ verdict: "pass", matches: [], latency_ms: 1 });
    llmVerify.mockResolvedValue({
      verdict: "borderline",
      reason: "경계",
      latency_ms: 50,
    });
    fallbackSelect.mockResolvedValue(fallbackQuest);

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    expect(fallbackSelect).toHaveBeenCalledTimes(1);
    // 폴백 퀘스트는 original_habit/worldview_id가 현재 요청값으로 오버라이드된 새 객체.
    expect(result.quest.original_habit).toBe("아침 7시 기상");
    expect(result.quest.worldview_id).toBe("kingdom_of_light");
    expect(result.quest.quest_name).toBe("안전 폴백");
    expect(result.filter_result.stage).toBe("llm");
    expect(result.filter_result.verdict).toBe("borderline");
    expect(result.filter_result.blocked).toBe(true);
    // borderline은 모니터링용 console.warn 1회 호출.
    expect(warnSpy).toHaveBeenCalled();
  });

  it("6) per-stage 지연이 filter_result에 반영된다", async () => {
    const originalQuest = makeQuest();

    const { pipeline, ruleCheck, llmVerify } = makeMocks();

    ruleCheck.mockReturnValue({ verdict: "pass", matches: [], latency_ms: 3 });
    llmVerify.mockResolvedValue({ verdict: "safe", latency_ms: 42 });

    const result = await pipeline.apply({
      quest: originalQuest,
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-12",
    });

    expect(typeof result.filter_result.latency_ms).toBe("number");
    expect(result.filter_result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.filter_result.rule_latency_ms).toBe(3);
    expect(result.filter_result.llm_latency_ms).toBe(42);
  });
});
