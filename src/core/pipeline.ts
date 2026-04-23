// F-004 Task 5 — IntegratedPipeline.
//
// 책임:
// - Redis 캐시 조회 → QuestRetriever 호출 → 장애 발생 시 graceful degradation 체인을 조립한다.
// - 새 GenerateResponseMeta(processing_path / safety_check / model_used / tokens / cost)
//   포맷에 맞춰 응답을 만든다.
//
// 흐름 요약:
//   1) regenerate=false → cache?.get(key); HIT → 즉시 반환 (processing_path="cache").
//   2) Promise.race([retriever.retrieve(req), timeoutAfter(timeoutMs)])
//      - 성공: meta.path 별로 processing_path / safety_check / usage 매핑.
//        · vector_exact         → safety=passed, tokens=0, model_used=null
//        · vector_modify        → safety=mapFilter, llm_usage 사용
//        · llm_new + safe       → safety=mapFilter, llm_usage 사용 + cache.set(key, quest)
//        · llm_new + blocked    → processing_path="fallback", safety="fallback", tokens=0
//      - 실패(throw 또는 timeout):
//        3) transformer.transform(req, { signal: AbortSignal.timeout(timeoutMs) }) 직접 호출
//           - 성공 + safetyPipeline 주입:
//             · blocked=false → processing_path="llm_new", safety=mapFilter, transformer usage 사용
//             · blocked=true  → fallback.select() 호출 → processing_path="fallback"
//           - 성공 + safetyPipeline 미주입 → processing_path="llm_new", safety="passed"
//           - 실패(throw) → fallback.select() → processing_path="fallback"
//   4) latency_ms = run() 전체 wall-time
//   5) estimated_cost_usd = model_used ? estimateCostUsd(model_used, pt, ct) : 0
//
// 설계 메모:
// - retriever 실패 후 transformer를 직접 호출할 때, safetyPipeline이 자체적으로 폴백
//   퀘스트로 교체했더라도 우리는 명시적으로 this.deps.fallback.select()를 호출해 그 결과를
//   사용한다. 두 폴백 경로의 결과를 일원화하기 위함이다 (테스트 case 8 참고).
// - cache.set은 retriever 경로의 llm_new + blocked=false 에서만 호출한다. direct-transformer
//   경로의 safe 결과는 graceful degradation 산출물이라 캐싱하지 않는다(품질 보장 미흡 가능성).
// - timeoutMs는 retriever와 transformer 각각에 신선하게 적용된다(잔여 budget 사용 안 함).
//   PoC 단계의 단순화. retriever는 AbortSignal을 받지 않으므로 Promise.race로 타임아웃만 강제.

import { estimateCostUsd } from "../config.js";
import { type RedisCache, buildCacheKey } from "./cache.js";
import type { QuestRetriever } from "./retriever.js";
import type { FallbackSelector } from "./safety/fallback-selector.js";
import type { SafetyFilterPipeline } from "./safety/pipeline.js";
import type {
  FilterResult,
  GenerateResponse,
  TransformRequest,
} from "./schemas/api.js";
import type { Quest } from "./schemas/quest.js";
import type { QuestTransformer } from "./transformer.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface IntegratedPipelineDeps {
  retriever: Pick<QuestRetriever, "retrieve">;
  transformer: Pick<QuestTransformer, "transform">;
  fallback: Pick<FallbackSelector, "select">;
  cache?: Pick<RedisCache, "get" | "set">;
  safetyPipeline?: Pick<SafetyFilterPipeline, "apply">;
  timeoutMs?: number;
}

// FilterResult → safety_check 매핑.
// 우선순위: blocked > replaced > passed.
function mapFilter(fr?: FilterResult): "passed" | "replaced" | "fallback" {
  if (!fr) return "passed";
  if (fr.blocked) return "fallback";
  if (fr.verdict === "replaced") return "replaced";
  return "passed";
}

// Promise.race용 타임아웃. retriever는 AbortSignal을 받지 않으므로 백그라운드에서
// 계속 실행될 수 있으나, 응답 시점만 강제로 끊는다(PoC 트레이드오프).
// clearTimeout 콜백으로 타이머 핸들 누수를 방지한다.
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`pipeline timeout after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => {
    clearTimeout(timer);
  }) as Promise<T>;
}

export class IntegratedPipeline {
  private readonly timeoutMs: number;

  constructor(private readonly deps: IntegratedPipelineDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(req: TransformRequest): Promise<GenerateResponse> {
    const start = Date.now();
    const key = buildCacheKey(req);

    // Step 1: cache HIT (regenerate=false 일 때만).
    if (!req.regenerate && this.deps.cache) {
      const cached = await this.safeGet(key);
      if (cached) {
        // F-001 계약: 캐시 키 정의가 변경되어도 original_habit/worldview_id가
        // 항상 현재 요청값을 반영하도록 방어적으로 강제 주입한다.
        return this.compose({
          quest: { ...cached, original_habit: req.habit_text, worldview_id: req.worldview_id },
          processing_path: "cache",
          safety_check: "passed",
          similarity_score: null,
          model_used: null,
          prompt_tokens: 0,
          completion_tokens: 0,
          start,
        });
      }
    }

    // Step 2: retriever 시도 (Promise.race로 타임아웃 강제).
    try {
      const result = await raceWithTimeout(
        this.deps.retriever.retrieve(req),
        this.timeoutMs,
      );

      const { meta, quest } = result;

      if (meta.path === "vector_exact") {
        return this.compose({
          quest,
          processing_path: "vector_exact",
          safety_check: "passed",
          similarity_score: meta.similarity,
          model_used: null,
          prompt_tokens: 0,
          completion_tokens: 0,
          start,
        });
      }

      if (meta.path === "vector_modify") {
        const usage = meta.llm_usage;
        return this.compose({
          quest,
          processing_path: "vector_modify",
          safety_check: mapFilter(meta.filter_result),
          similarity_score: meta.similarity,
          model_used: usage?.model ?? null,
          prompt_tokens: usage?.prompt_tokens ?? 0,
          completion_tokens: usage?.completion_tokens ?? 0,
          start,
        });
      }

      // path === "llm_new"
      if (meta.filter_result?.blocked) {
        // retriever가 이미 자체 fallback quest로 교체해 반환한 상태.
        // processing_path만 "fallback"으로 표기하고 토큰/비용은 0으로 보고한다.
        return this.compose({
          quest,
          processing_path: "fallback",
          safety_check: "fallback",
          similarity_score: meta.similarity,
          model_used: null,
          prompt_tokens: 0,
          completion_tokens: 0,
          start,
        });
      }

      // safe llm_new — 다음 동일 요청 가속을 위해 캐시에 저장 (베스트-에포트).
      if (this.deps.cache) {
        await this.deps.cache.set(key, quest);
      }
      const usage = meta.llm_usage;
      return this.compose({
        quest,
        processing_path: "llm_new",
        safety_check: mapFilter(meta.filter_result),
        similarity_score: meta.similarity,
        model_used: usage?.model ?? null,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        start,
      });
    } catch (cause) {
      console.warn("[IntegratedPipeline] retriever 실패 → 복구 경로 진입:", cause);
      return await this.recoverViaTransformer(req, start);
    }
  }

  // retriever 실패 시 transformer를 직접 호출하는 복구 경로.
  private async recoverViaTransformer(
    req: TransformRequest,
    start: number,
  ): Promise<GenerateResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let transformed: Awaited<ReturnType<typeof this.deps.transformer.transform>>;
    try {
      transformed = await this.deps.transformer.transform(req, { signal });
    } catch (cause) {
      console.warn("[IntegratedPipeline] transformer 직접 호출 실패 → fallback:", cause);
      return await this.fallbackResponse(req, start);
    }

    if (this.deps.safetyPipeline) {
      const filtered = await this.deps.safetyPipeline.apply({
        quest: transformed.quest,
        habitText: req.habit_text,
        worldviewId: req.worldview_id,
        ageGroup: req.age_group,
      });

      if (filtered.filter_result.blocked) {
        // safetyPipeline은 자체 fallback을 반환하지만, 다른 fallback 경로와의 메타
        // 매핑 일관성을 위해 명시적으로 fallback.select()를 호출해 그 결과를 사용한다.
        return await this.fallbackResponse(req, start);
      }

      return this.compose({
        quest: filtered.quest,
        processing_path: "llm_new",
        safety_check: mapFilter(filtered.filter_result),
        similarity_score: null,
        model_used: transformed.meta.model,
        prompt_tokens: transformed.meta.prompt_tokens,
        completion_tokens: transformed.meta.completion_tokens,
        start,
      });
    }

    // safetyPipeline 미주입 — transformer 결과를 그대로 반환.
    return this.compose({
      quest: transformed.quest,
      processing_path: "llm_new",
      safety_check: "passed",
      similarity_score: null,
      model_used: transformed.meta.model,
      prompt_tokens: transformed.meta.prompt_tokens,
      completion_tokens: transformed.meta.completion_tokens,
      start,
    });
  }

  private async fallbackResponse(
    req: TransformRequest,
    start: number,
  ): Promise<GenerateResponse> {
    const fallbackQuest = await this.deps.fallback.select({
      habitText: req.habit_text,
      worldviewId: req.worldview_id,
      ageGroup: req.age_group,
    });
    // F-001 계약: original_habit / worldview_id는 항상 현재 요청값으로 강제 주입.
    // FallbackSelector가 반환한 seed quest에는 저장 당시의 original_habit이 있을 수 있어
    // 사용자 요청과 다를 수 있다 — 일관성 보장을 위해 덮어쓴다.
    return this.compose({
      quest: { ...fallbackQuest, original_habit: req.habit_text, worldview_id: req.worldview_id },
      processing_path: "fallback",
      safety_check: "fallback",
      similarity_score: null,
      model_used: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      start,
    });
  }

  // cache.get 실패는 조용히 흡수하고 MISS로 취급한다 (RedisCache.get 자체도 swallow하지만
  // 방어적으로 한 번 더 try/catch 처리).
  private async safeGet(key: string): Promise<Quest | null> {
    if (!this.deps.cache) return null;
    try {
      return await this.deps.cache.get(key);
    } catch {
      return null;
    }
  }

  // 응답 메타 합성 — latency_ms와 estimated_cost_usd 계산을 단일 지점으로 모은다.
  private compose(params: {
    quest: Quest;
    processing_path: GenerateResponse["meta"]["processing_path"];
    safety_check: GenerateResponse["meta"]["safety_check"];
    similarity_score: number | null;
    model_used: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    start: number;
  }): GenerateResponse {
    const cost = params.model_used
      ? estimateCostUsd(
          params.model_used,
          params.prompt_tokens,
          params.completion_tokens,
        )
      : 0;
    return {
      quest: params.quest,
      meta: {
        processing_path: params.processing_path,
        safety_check: params.safety_check,
        similarity_score: params.similarity_score,
        latency_ms: Date.now() - params.start,
        model_used: params.model_used,
        prompt_tokens: params.prompt_tokens,
        completion_tokens: params.completion_tokens,
        estimated_cost_usd: cost,
      },
    };
  }
}

// 라우트 핸들러에서 사용할 좁은 포트 (테스트 모킹 단순화).
export type IntegratedPipelinePort = Pick<IntegratedPipeline, "run">;
