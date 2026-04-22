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

const baseMeta = {
  path: "vector_exact" as const,
  similarity: 0.92,
  latency_ms: 120,
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

describe("GenerateResponseSchema filter_result 확장", () => {
  it("filter_result 미포함(기존 응답)도 하위 호환으로 파싱된다", () => {
    const parsed = GenerateResponseSchema.parse({
      quest: sampleQuest,
      meta: baseMeta,
    });
    expect(parsed.meta.filter_result).toBeUndefined();
    expect(parsed.meta.path).toBe("vector_exact");
    expect(parsed.meta.similarity).toBe(0.92);
    expect(parsed.meta.latency_ms).toBe(120);
  });

  it("filter_result 포함 응답이 파싱된다", () => {
    const parsed = GenerateResponseSchema.parse({
      quest: sampleQuest,
      meta: {
        ...baseMeta,
        filter_result: {
          stage: "llm",
          verdict: "replaced",
          blocked: false,
          latency_ms: 850,
          rule_latency_ms: 2,
          llm_latency_ms: 848,
        },
      },
    });
    expect(parsed.meta.filter_result?.stage).toBe("llm");
    expect(parsed.meta.filter_result?.verdict).toBe("replaced");
    expect(parsed.meta.filter_result?.blocked).toBe(false);
    expect(parsed.meta.filter_result?.latency_ms).toBe(850);
  });

  it("filter_result.stage enum 위반 시 전체 응답 파싱이 실패한다", () => {
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: {
        ...baseMeta,
        filter_result: {
          stage: "bogus",
          verdict: "safe",
          blocked: false,
          latency_ms: 3,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("filter_result.verdict enum 위반 시 전체 응답 파싱이 실패한다", () => {
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: {
        ...baseMeta,
        filter_result: {
          stage: "rule",
          verdict: "bogus",
          blocked: false,
          latency_ms: 3,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("기존 meta 필수 필드(path/similarity/latency_ms)는 여전히 필수다", () => {
    const result = GenerateResponseSchema.safeParse({
      quest: sampleQuest,
      meta: {
        path: "vector_exact",
        similarity: 0.92,
        // latency_ms 누락
        filter_result: {
          stage: "rule",
          verdict: "safe",
          blocked: false,
          latency_ms: 3,
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
