// F-004 Task 5 — IntegratedPipeline 계약 테스트.
//
// IntegratedPipeline은 다음 4개 의존성을 합성한다:
//   - retriever (QuestRetriever)        : 캐시 미스 시 1차 시도 (vector_exact / vector_modify / llm_new)
//   - transformer (QuestTransformer)    : retriever 실패 시 직접 호출 (graceful degradation 1단계)
//   - safetyPipeline (optional)         : 직접 transformer 경로에서 안전 필터 적용
//   - fallback (FallbackSelector)       : safetyPipeline blocked / transformer 자체 throw 시 (graceful degradation 2단계)
//   - cache (RedisCache, optional)      : regenerate=false일 때 입력 키로 사전 조회
//
// 모든 의존성은 vi.fn() 페이크 객체로 교체한다 — 실제 LLM/Vector/Redis 호출 없음.
//
// 응답 메타 매핑 (스펙 §3.4 PRD 확정 응답 스키마):
//   processing_path : cache | vector_exact | vector_modify | llm_new | fallback
//   safety_check    : passed | replaced | fallback
//   similarity_score / model_used : nullable
//   latency_ms      : run() 전체 wall-time
//   prompt/completion_tokens : LLM 호출이 없는 경로(cache, vector_exact, fallback)에서는 0
//   estimated_cost_usd : model_used가 null이면 0, 그렇지 않으면 estimateCostUsd(...)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCacheKey, type RedisCache } from "../../src/core/cache.js";
import {
  IntegratedPipeline,
  type IntegratedPipelineDeps,
} from "../../src/core/pipeline.js";
import type { QuestRetriever, RetrieveResult } from "../../src/core/retriever.js";
import type { FallbackSelector } from "../../src/core/safety/fallback-selector.js";
import type { SafetyFilterPipeline } from "../../src/core/safety/pipeline.js";
import {
  GenerateResponseSchema,
  type FilterResult,
  type TransformRequest,
  type TransformResponse,
} from "../../src/core/schemas/api.js";
import type { Quest } from "../../src/core/schemas/quest.js";
import type { QuestTransformer } from "../../src/core/transformer.js";

// ── 픽스처 ──────────────────────────────────────────────────────────────

const QUEST: Quest = {
  quest_name: "빛의 서약 실행",
  description: "아침에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10 },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
};

const FALLBACK_QUEST: Quest = {
  ...QUEST,
  quest_name: "안전한 폴백 퀘스트",
  description: "안전 필터 차단 시 사용되는 빌트인 폴백.",
};

const REQ: TransformRequest = {
  habit_text: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
  age_group: "7-12",
  regenerate: false,
};

const REQ_REGEN: TransformRequest = { ...REQ, regenerate: true };

const SAFE_FILTER: FilterResult = {
  stage: "llm",
  verdict: "safe",
  blocked: false,
  latency_ms: 50,
};

const REPLACED_FILTER: FilterResult = {
  stage: "rule",
  verdict: "replaced",
  blocked: false,
  latency_ms: 5,
};

const BLOCKED_FILTER: FilterResult = {
  stage: "llm",
  verdict: "unsafe",
  blocked: true,
  latency_ms: 60,
};

// ── 모킹 헬퍼 ──────────────────────────────────────────────────────────

interface Mocks {
  retriever: { retrieve: ReturnType<typeof vi.fn> };
  transformer: { transform: ReturnType<typeof vi.fn> };
  fallback: { select: ReturnType<typeof vi.fn> };
  cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  safetyPipeline: { apply: ReturnType<typeof vi.fn> };
}

function newMocks(): Mocks {
  return {
    retriever: { retrieve: vi.fn() },
    transformer: { transform: vi.fn() },
    fallback: { select: vi.fn() },
    cache: { get: vi.fn(), set: vi.fn() },
    safetyPipeline: { apply: vi.fn() },
  };
}

function buildPipeline(
  m: Mocks,
  options: { withCache?: boolean; withSafety?: boolean; timeoutMs?: number } = {},
): IntegratedPipeline {
  const deps: IntegratedPipelineDeps = {
    retriever: m.retriever as unknown as Pick<QuestRetriever, "retrieve">,
    transformer: m.transformer as unknown as Pick<QuestTransformer, "transform">,
    fallback: m.fallback as unknown as Pick<FallbackSelector, "select">,
  };
  if (options.withCache !== false) {
    deps.cache = m.cache as unknown as RedisCache;
  }
  if (options.withSafety !== false) {
    deps.safetyPipeline = m.safetyPipeline as unknown as SafetyFilterPipeline;
  }
  if (options.timeoutMs !== undefined) {
    deps.timeoutMs = options.timeoutMs;
  }
  return new IntegratedPipeline(deps);
}

// 토큰 메타 보유 모델 — config.MODEL_PRICING에 등록된 모델을 사용해 비용>0 검증.
const PRICED_MODEL = "claude-haiku-4-5-20251001";

function vectorExactResult(): RetrieveResult {
  return {
    quest: QUEST,
    meta: { path: "vector_exact", similarity: 0.95, latency_ms: 30 },
  };
}

function vectorModifyResult(): RetrieveResult {
  return {
    quest: QUEST,
    meta: {
      path: "vector_modify",
      similarity: 0.82,
      latency_ms: 800,
      filter_result: SAFE_FILTER,
      llm_usage: { model: PRICED_MODEL, prompt_tokens: 1000, completion_tokens: 500 },
    },
  };
}

function llmNewSafeResult(): RetrieveResult {
  return {
    quest: QUEST,
    meta: {
      path: "llm_new",
      similarity: null,
      latency_ms: 1500,
      filter_result: SAFE_FILTER,
      llm_usage: { model: PRICED_MODEL, prompt_tokens: 2000, completion_tokens: 800 },
    },
  };
}

function llmNewBlockedResult(): RetrieveResult {
  return {
    quest: FALLBACK_QUEST,
    meta: {
      path: "llm_new",
      similarity: null,
      latency_ms: 1800,
      filter_result: BLOCKED_FILTER,
      llm_usage: { model: PRICED_MODEL, prompt_tokens: 2000, completion_tokens: 800 },
    },
  };
}

function transformerResponse(): TransformResponse {
  return {
    quest: QUEST,
    meta: {
      model: PRICED_MODEL,
      latency_ms: 1200,
      prompt_tokens: 1500,
      completion_tokens: 600,
    },
  };
}

// ── 테스트 ─────────────────────────────────────────────────────────────

describe("IntegratedPipeline.run", () => {
  let m: Mocks;

  beforeEach(() => {
    m = newMocks();
  });

  // 1) cache HIT — retriever/transformer/safety/fallback 모두 호출 안 됨.
  it("regenerate=false + cache HIT → processing_path=cache, safety_check=passed, tokens=0", async () => {
    m.cache.get.mockResolvedValueOnce(QUEST);
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    // 응답 스키마 검증.
    expect(GenerateResponseSchema.safeParse(res).success).toBe(true);

    expect(res.quest).toEqual(QUEST);
    expect(res.meta.processing_path).toBe("cache");
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.similarity_score).toBeNull();
    expect(res.meta.model_used).toBeNull();
    expect(res.meta.prompt_tokens).toBe(0);
    expect(res.meta.completion_tokens).toBe(0);
    expect(res.meta.estimated_cost_usd).toBe(0);
    expect(res.meta.latency_ms).toBeGreaterThanOrEqual(0);

    expect(m.cache.get).toHaveBeenCalledWith(buildCacheKey(REQ));
    expect(m.retriever.retrieve).not.toHaveBeenCalled();
    expect(m.transformer.transform).not.toHaveBeenCalled();
    expect(m.fallback.select).not.toHaveBeenCalled();
  });

  // 2) cache MISS → retriever vector_exact.
  it("cache MISS → retriever vector_exact → similarity_score=0.95, safety_check=passed, tokens=0", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce(vectorExactResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(GenerateResponseSchema.safeParse(res).success).toBe(true);
    expect(res.quest).toEqual(QUEST);
    expect(res.meta.processing_path).toBe("vector_exact");
    expect(res.meta.similarity_score).toBe(0.95);
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.model_used).toBeNull();
    expect(res.meta.prompt_tokens).toBe(0);
    expect(res.meta.completion_tokens).toBe(0);
    expect(res.meta.estimated_cost_usd).toBe(0);

    expect(m.cache.get).toHaveBeenCalledTimes(1);
    expect(m.retriever.retrieve).toHaveBeenCalledTimes(1);
    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 3) cache MISS → retriever vector_modify (llm_usage 보유).
  it("cache MISS → retriever vector_modify (with llm_usage) → safety_check=passed, model_used/cost 반영", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce(vectorModifyResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(GenerateResponseSchema.safeParse(res).success).toBe(true);
    expect(res.meta.processing_path).toBe("vector_modify");
    expect(res.meta.similarity_score).toBe(0.82);
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.model_used).toBe(PRICED_MODEL);
    expect(res.meta.prompt_tokens).toBe(1000);
    expect(res.meta.completion_tokens).toBe(500);
    expect(res.meta.estimated_cost_usd).toBeGreaterThan(0);

    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 4) llm_new + blocked=false → cache.set 호출.
  it("retriever llm_new + blocked=false → processing_path=llm_new, cache.set 호출", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce(llmNewSafeResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.meta.processing_path).toBe("llm_new");
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.model_used).toBe(PRICED_MODEL);
    expect(res.meta.prompt_tokens).toBe(2000);
    expect(res.meta.completion_tokens).toBe(800);
    expect(res.meta.estimated_cost_usd).toBeGreaterThan(0);

    expect(m.cache.set).toHaveBeenCalledTimes(1);
    expect(m.cache.set).toHaveBeenCalledWith(buildCacheKey(REQ), QUEST);
  });

  // 5) llm_new + blocked=true → fallback 분류, cache.set 미호출.
  it("retriever llm_new + blocked=true → processing_path=fallback, safety_check=fallback, cache.set 미호출, tokens=0", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce(llmNewBlockedResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.quest).toEqual(FALLBACK_QUEST);
    expect(res.meta.processing_path).toBe("fallback");
    expect(res.meta.safety_check).toBe("fallback");
    expect(res.meta.model_used).toBeNull();
    expect(res.meta.prompt_tokens).toBe(0);
    expect(res.meta.completion_tokens).toBe(0);
    expect(res.meta.estimated_cost_usd).toBe(0);

    expect(m.cache.set).not.toHaveBeenCalled();
    // retriever가 자체 fallback을 반환했으므로 우리는 추가 fallback.select를 호출하지 않는다.
    expect(m.fallback.select).not.toHaveBeenCalled();
  });

  // 6) Redis get 오류 → null 취급, retriever 정상 호출.
  it("cache.get throw → 조용히 무시하고 retriever를 호출한다 (MISS와 동일)", async () => {
    m.cache.get.mockRejectedValueOnce(new Error("Redis 연결 실패"));
    m.retriever.retrieve.mockResolvedValueOnce(vectorExactResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.meta.processing_path).toBe("vector_exact");
    expect(m.retriever.retrieve).toHaveBeenCalledTimes(1);
  });

  // 7) retriever throw → transformer 직접 호출 → safe.
  it("retriever throw → transformer 직접 호출 → safetyPipeline safe → processing_path=llm_new, safety_check=passed", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockRejectedValueOnce(new Error("Vector DB 장애"));
    m.transformer.transform.mockResolvedValueOnce(transformerResponse());
    m.safetyPipeline.apply.mockResolvedValueOnce({
      quest: QUEST,
      filter_result: SAFE_FILTER,
    });
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.quest).toEqual(QUEST);
    expect(res.meta.processing_path).toBe("llm_new");
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.model_used).toBe(PRICED_MODEL);
    expect(res.meta.prompt_tokens).toBe(1500);
    expect(res.meta.completion_tokens).toBe(600);
    expect(res.meta.estimated_cost_usd).toBeGreaterThan(0);

    expect(m.transformer.transform).toHaveBeenCalledTimes(1);
    // transformer 호출 시 AbortSignal이 두 번째 인자로 전달되었는지 확인.
    const [, transformOptions] = m.transformer.transform.mock.calls[0] ?? [];
    expect(transformOptions?.signal).toBeInstanceOf(AbortSignal);

    expect(m.safetyPipeline.apply).toHaveBeenCalledTimes(1);
    expect(m.fallback.select).not.toHaveBeenCalled();
    // direct-transformer 경로에서는 cache.set을 호출하지 않는다.
    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 8) retriever throw → transformer safe but safetyPipeline blocked → fallback.
  it("retriever throw → transformer 직접 호출 → safetyPipeline blocked → fallback.select 호출, processing_path=fallback", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockRejectedValueOnce(new Error("Vector DB 장애"));
    m.transformer.transform.mockResolvedValueOnce(transformerResponse());
    m.safetyPipeline.apply.mockResolvedValueOnce({
      // safetyPipeline은 자체 fallback quest를 반환하지만, 우리는 명시적으로
      // this.deps.fallback.select()를 호출해 그 결과를 사용한다.
      quest: FALLBACK_QUEST,
      filter_result: BLOCKED_FILTER,
    });
    m.fallback.select.mockResolvedValueOnce(FALLBACK_QUEST);
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.quest).toEqual(FALLBACK_QUEST);
    expect(res.meta.processing_path).toBe("fallback");
    expect(res.meta.safety_check).toBe("fallback");
    expect(res.meta.model_used).toBeNull();
    expect(res.meta.prompt_tokens).toBe(0);
    expect(res.meta.completion_tokens).toBe(0);
    expect(res.meta.estimated_cost_usd).toBe(0);

    expect(m.fallback.select).toHaveBeenCalledTimes(1);
    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 9) retriever throw → transformer throw → fallback.
  it("retriever throw → transformer throw → fallback.select 호출, processing_path=fallback", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockRejectedValueOnce(new Error("Vector DB 장애"));
    m.transformer.transform.mockRejectedValueOnce(new Error("Anthropic 타임아웃"));
    m.fallback.select.mockResolvedValueOnce(FALLBACK_QUEST);
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.quest).toEqual(FALLBACK_QUEST);
    expect(res.meta.processing_path).toBe("fallback");
    expect(res.meta.safety_check).toBe("fallback");
    expect(res.meta.model_used).toBeNull();
    expect(res.meta.prompt_tokens).toBe(0);
    expect(res.meta.completion_tokens).toBe(0);
    expect(res.meta.estimated_cost_usd).toBe(0);

    expect(m.fallback.select).toHaveBeenCalledTimes(1);
    expect(m.safetyPipeline.apply).not.toHaveBeenCalled();
    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 10) regenerate=true → cache.get 미호출.
  it("regenerate=true → cache.get을 호출하지 않고 retriever로 직진", async () => {
    m.retriever.retrieve.mockResolvedValueOnce(llmNewSafeResult());
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ_REGEN);

    expect(m.cache.get).not.toHaveBeenCalled();
    expect(res.meta.processing_path).toBe("llm_new");
    // regenerate라도 llm_new safe 경로면 cache.set은 여전히 호출 (다음 동일 요청 가속).
    expect(m.cache.set).toHaveBeenCalledTimes(1);
  });

  // 11) llm_new + blocked=false → cache.set 인자 검증 (case 4 보강).
  it("retriever llm_new + safe → cache.set이 (key, quest)로 호출된다", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce(llmNewSafeResult());
    const pipeline = buildPipeline(m);

    await pipeline.run(REQ);

    expect(m.cache.set).toHaveBeenCalledTimes(1);
    const [key, quest] = m.cache.set.mock.calls[0] ?? [];
    expect(key).toBe(buildCacheKey(REQ));
    expect(quest).toEqual(QUEST);
  });

  // F-001 계약 회귀: fallbackResponse가 original_habit / worldview_id를 요청값으로 강제 주입하는지.
  // FallbackSelector는 seed quest(다른 original_habit)를 반환할 수 있다.
  it("retriever throw → transformer throw → 폴백 quest의 original_habit은 req.habit_text로 강제 주입된다", async () => {
    const SEED_QUEST: Quest = {
      ...FALLBACK_QUEST,
      original_habit: "기본 습관",       // req.habit_text와 다른 값
      worldview_id: "other_worldview",    // req.worldview_id와 다른 값
    };
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockRejectedValueOnce(new Error("Vector DB 장애"));
    m.transformer.transform.mockRejectedValueOnce(new Error("Anthropic 타임아웃"));
    m.fallback.select.mockResolvedValueOnce(SEED_QUEST);
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.meta.processing_path).toBe("fallback");
    // 요청의 habit_text / worldview_id로 덮어쓰여야 한다.
    expect(res.quest.original_habit).toBe(REQ.habit_text);
    expect(res.quest.worldview_id).toBe(REQ.worldview_id);
  });

  // 보너스 — replaced filter 매핑 검증.
  it("retriever vector_modify + replaced filter → safety_check=replaced", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockResolvedValueOnce({
      quest: QUEST,
      meta: {
        path: "vector_modify",
        similarity: 0.81,
        latency_ms: 700,
        filter_result: REPLACED_FILTER,
        llm_usage: { model: PRICED_MODEL, prompt_tokens: 900, completion_tokens: 400 },
      },
    });
    const pipeline = buildPipeline(m);

    const res = await pipeline.run(REQ);

    expect(res.meta.safety_check).toBe("replaced");
  });

  // 보너스 — cache 미주입(undefined) 시 cache 분기는 모두 스킵된다.
  it("cache 미주입 → cache 경로 미사용, retriever 정상 호출, set 시도 없음", async () => {
    m.retriever.retrieve.mockResolvedValueOnce(llmNewSafeResult());
    const pipeline = buildPipeline(m, { withCache: false });

    const res = await pipeline.run(REQ);

    expect(res.meta.processing_path).toBe("llm_new");
    expect(m.cache.get).not.toHaveBeenCalled();
    expect(m.cache.set).not.toHaveBeenCalled();
  });

  // 보너스 — safetyPipeline 미주입 + retriever throw → transformer 결과를 그대로 반환.
  it("safetyPipeline 미주입 + retriever throw → transformer safe 반환, safety_check=passed", async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.retriever.retrieve.mockRejectedValueOnce(new Error("Vector DB 장애"));
    m.transformer.transform.mockResolvedValueOnce(transformerResponse());
    const pipeline = buildPipeline(m, { withSafety: false });

    const res = await pipeline.run(REQ);

    expect(res.meta.processing_path).toBe("llm_new");
    expect(res.meta.safety_check).toBe("passed");
    expect(res.meta.model_used).toBe(PRICED_MODEL);
    expect(m.safetyPipeline.apply).not.toHaveBeenCalled();
    expect(m.fallback.select).not.toHaveBeenCalled();
  });
});
