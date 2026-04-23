import { describe, expect, it } from "vitest";
import {
  FilterResultSchema,
  GenerateResponseSchema,
} from "../../../src/core/schemas/api.js";
import type { FilterResult } from "../../../src/core/schemas/api.js";

// F-003 Task 1 — Safety Filter 결과 스키마.
// FilterResultSchema 및 GenerateResponseMetaSchema.filter_result 확장 검증.

const sampleQuest = {
  quest_name: "새벽 마나 충전 의식",
  description: "7시에 눈을 뜨고 스트레칭으로 마나를 충전한다.",
  category: "기상/취침" as const,
  stat_mapping: { 체력: 2 },
  reward: { exp: 30, coin: 10 },
  suggested_grade: "B" as const,
  mandatory_suitability: "high" as const,
  original_habit: "아침 7시에 일어나기",
  worldview_id: "isekai-academy-v1",
};

// F-004 Task 5 — GenerateResponseMetaSchema가 PRD 확정 스키마로 교체됨에 따라
// baseMeta도 새 필드(processing_path / safety_check / model_used / tokens / cost)로 갱신.
// FilterResult는 더 이상 응답 meta에 포함되지 않고 IntegratedPipeline 내부에서
// safety_check enum으로 매핑된다.
const baseMeta = {
  processing_path: "vector_exact" as const,
  similarity_score: 0.92,
  safety_check: "passed" as const,
  latency_ms: 120,
  model_used: null,
  prompt_tokens: 0,
  completion_tokens: 0,
  estimated_cost_usd: 0,
};

describe("FilterResultSchema", () => {
  it("유효한 filter_result(필수 필드만)를 파싱한다", () => {
    const parsed = FilterResultSchema.parse({
      stage: "rule",
      verdict: "safe",
      blocked: false,
      latency_ms: 3,
    });
    expect(parsed.stage).toBe("rule");
    expect(parsed.verdict).toBe("safe");
    expect(parsed.blocked).toBe(false);
    expect(parsed.latency_ms).toBe(3);
    expect(parsed.rule_latency_ms).toBeUndefined();
    expect(parsed.llm_latency_ms).toBeUndefined();
  });

  it("optional 필드(rule_latency_ms, llm_latency_ms)를 포함해도 파싱된다", () => {
    const parsed = FilterResultSchema.parse({
      stage: "llm",
      verdict: "replaced",
      blocked: false,
      latency_ms: 850,
      rule_latency_ms: 2,
      llm_latency_ms: 848,
    });
    expect(parsed.rule_latency_ms).toBe(2);
    expect(parsed.llm_latency_ms).toBe(848);
  });

  it("stage enum 위반('unknown') 시 실패한다", () => {
    const result = FilterResultSchema.safeParse({
      stage: "unknown",
      verdict: "safe",
      blocked: false,
      latency_ms: 3,
    });
    expect(result.success).toBe(false);
  });

  it("verdict enum 위반('invalid') 시 실패한다", () => {
    const result = FilterResultSchema.safeParse({
      stage: "rule",
      verdict: "invalid",
      blocked: false,
      latency_ms: 3,
    });
    expect(result.success).toBe(false);
  });

  it("blocked가 boolean이 아니면(문자열) 실패한다", () => {
    const result = FilterResultSchema.safeParse({
      stage: "rule",
      verdict: "safe",
      blocked: "false",
      latency_ms: 3,
    });
    expect(result.success).toBe(false);
  });

  it("latency_ms가 number가 아니면(문자열) 실패한다", () => {
    const result = FilterResultSchema.safeParse({
      stage: "rule",
      verdict: "safe",
      blocked: false,
      latency_ms: "3",
    });
    expect(result.success).toBe(false);
  });

  it("verdict의 네 가지 값(safe/unsafe/borderline/replaced)을 모두 허용한다", () => {
    const verdicts: FilterResult["verdict"][] = [
      "safe",
      "unsafe",
      "borderline",
      "replaced",
    ];
    for (const verdict of verdicts) {
      const result = FilterResultSchema.safeParse({
        stage: "llm",
        verdict,
        blocked: verdict === "unsafe",
        latency_ms: 10,
      });
      expect(result.success).toBe(true);
    }
  });
});

// F-004 Task 5 — 응답 메타 스키마가 PRD 확정 형태로 교체되어, filter_result는
// 더 이상 GenerateResponseMeta에 포함되지 않는다. IntegratedPipeline이
// safety_check enum("passed" / "replaced" / "fallback")으로 매핑한다.
// 본 describe는 새 메타 필드의 필수성과 enum 제약을 회귀 방지한다.
describe("GenerateResponseSchema 새 메타 필드 (F-004)", () => {
  it("새 메타 필드 모두 포함 시 파싱 성공", () => {
    const parsed = GenerateResponseSchema.parse({
      quest: sampleQuest,
      meta: baseMeta,
    });
    expect(parsed.meta.processing_path).toBe("vector_exact");
    expect(parsed.meta.similarity_score).toBe(0.92);
    expect(parsed.meta.safety_check).toBe("passed");
    expect(parsed.meta.latency_ms).toBe(120);
    expect(parsed.meta.model_used).toBeNull();
    expect(parsed.meta.prompt_tokens).toBe(0);
    expect(parsed.meta.completion_tokens).toBe(0);
    expect(parsed.meta.estimated_cost_usd).toBe(0);
  });

  it("processing_path='cache' / model_used=null도 파싱된다", () => {
    const parsed = GenerateResponseSchema.parse({
      quest: sampleQuest,
      meta: {
        processing_path: "cache",
        similarity_score: null,
        safety_check: "passed",
        latency_ms: 5,
        model_used: null,
        prompt_tokens: 0,
        completion_tokens: 0,
        estimated_cost_usd: 0,
      },
    });
    expect(parsed.meta.processing_path).toBe("cache");
    expect(parsed.meta.similarity_score).toBeNull();
  });

  it("processing_path enum 위반 시 실패한다", () => {
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: { ...baseMeta, processing_path: "bogus" },
    });
    expect(result.success).toBe(false);
  });

  it("safety_check enum 위반 시 실패한다", () => {
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: { ...baseMeta, safety_check: "bogus" },
    });
    expect(result.success).toBe(false);
  });

  it("필수 필드(latency_ms) 누락 시 실패한다", () => {
    const { latency_ms: _omit, ...incomplete } = baseMeta;
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: incomplete,
    });
    expect(result.success).toBe(false);
  });

  it("similarity_score=null도 허용된다", () => {
    const parsed = GenerateResponseSchema.parse({
      quest: sampleQuest,
      meta: { ...baseMeta, similarity_score: null },
    });
    expect(parsed.meta.similarity_score).toBeNull();
  });
});
