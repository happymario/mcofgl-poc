// F-002 Task 6 — QuestRetriever: 3단계 체인 오케스트레이터.
//
// 책임:
// - habit_text 를 임베딩하고 (EmbeddingService),
// - Vector DB에서 유사 퀘스트를 검색한 뒤 (VectorStore),
// - 최상위 유사도에 따라 경로를 분기한다:
//     * similarity >= exact(0.9)           → vector_exact: 기존 퀘스트 재사용
//     * modify(0.7) <= similarity < exact  → vector_modify: 경량 수정 (LightModifier)
//     * similarity < modify or 히트 없음   → llm_new: QuestTransformer로 신규 생성 후 VectorStore에 저장
//
// 설계:
// - 의존성은 모두 생성자 주입 (테스트에서 페이크로 교체 가능).
// - llm_new 경로에서 1단계 임베딩을 재사용해 저장 시 재임베딩 비용을 방지한다.
// - 저장 실패는 로그만 남기고 사용자 응답은 성공으로 반환한다 (사용자 경험 우선).
// - QuestTransformer / LightModifier / VectorStore / EmbeddingService는
//   수정 없이 import만으로 재사용한다.

import type { LightModifier } from "./modifier.js";
import type { SafetyFilterPipeline } from "./safety/pipeline.js";
import type { FilterResult, TransformRequest } from "./schemas/api.js";
import type { Quest } from "./schemas/quest.js";
import type { QuestTransformer } from "./transformer.js";
import type { EmbeddingService } from "./vector/embedding.js";
import type { SearchHit, VectorStore } from "./vector/store.js";

export type RoutingPath = "vector_exact" | "vector_modify" | "llm_new";

export interface RetrieveMeta {
  path: RoutingPath;
  similarity: number | null;
  latency_ms: number;
  // F-003 Task 7 — safetyPipeline이 주입된 경우에만 설정된다.
  // vector_exact 경로는 저장된(승인된) 퀘스트를 재사용하므로 필터링 대상이 아니어서 undefined.
  filter_result?: FilterResult;
  // F-004 Task 2 — LLM 호출이 발생한 경로(vector_modify / llm_new)에서 사용한
  // 모델 및 토큰 사용량. 상위 파이프라인(IntegratedPipeline)에서 비용 집계에 활용한다.
  // vector_exact 경로는 LLM을 호출하지 않으므로 undefined.
  llm_usage?: { model: string; prompt_tokens: number; completion_tokens: number };
}

export interface RetrieveResult {
  quest: Quest;
  meta: RetrieveMeta;
}

export interface RetrieverThresholds {
  exact: number;
  modify: number;
}

export interface RetrieverDeps {
  embedding: EmbeddingService;
  store: VectorStore;
  modifier: LightModifier;
  transformer: QuestTransformer;
  thresholds?: RetrieverThresholds;
  // F-003 Task 7 — Safety Filter 파이프라인 (optional).
  // 주입되면 llm_new / vector_modify 경로의 출력에 apply()를 적용한다.
  // 주입되지 않으면 F-002와 동일하게 동작한다 (하위 호환).
  safetyPipeline?: SafetyFilterPipeline;
}

// 스펙 §3.1 기본 경로 분기 임계값.
const DEFAULT_THRESHOLDS: RetrieverThresholds = { exact: 0.9, modify: 0.7 };

export class QuestRetriever {
  private readonly thresholds: RetrieverThresholds;

  constructor(private readonly deps: RetrieverDeps) {
    const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
    if (t.exact < 0 || t.exact > 1 || t.modify < 0 || t.modify > 1) {
      throw new RangeError("thresholds.exact 및 thresholds.modify는 [0, 1] 범위여야 합니다");
    }
    if (t.exact <= t.modify) {
      throw new RangeError("thresholds.exact는 thresholds.modify보다 커야 합니다");
    }
    this.thresholds = t;
  }

  async retrieve(req: TransformRequest): Promise<RetrieveResult> {
    // latency_ms는 embed + search + (modify|transform) 전 구간 합산.
    // QuestTransformer.meta.latency_ms(transform 단독)와 의미가 다름에 유의.
    const start = Date.now();

    // 1) 임베딩 — 결과 벡터는 llm_new 경로에서 save 시 재사용한다.
    const embedding = await this.deps.embedding.embed(req.habit_text);

    // 2) Vector DB 검색 — 최상위 히트만 경로 판정에 사용한다.
    const hits = await this.deps.store.search({
      embedding,
      worldviewId: req.worldview_id,
      ageGroup: req.age_group,
    });
    const topHit = hits[0];
    const similarity = topHit?.similarity ?? null;

    // 3) 경로 분기.
    const path = this.route(topHit);

    if (path === "vector_exact" && topHit) {
      // F-001 계약: original_habit / worldview_id는 항상 요청값으로 강제 주입.
      // 저장된 quest의 seed habit과 혼동되지 않도록 caller가 동일한 의미를 보장.
      return {
        quest: { ...topHit.quest, original_habit: req.habit_text, worldview_id: req.worldview_id },
        meta: { path, similarity, latency_ms: Date.now() - start },
      };
    }

    if (path === "vector_modify" && topHit) {
      // F-004 Task 2 — modifier.modify는 { quest, usage }를 반환한다.
      // usage 는 meta.llm_usage 로 전파되어 상위 파이프라인에서 비용 집계에 활용된다.
      const { quest: modified, usage: modifierUsage } = await this.deps.modifier.modify({
        habitText: req.habit_text,
        worldviewId: req.worldview_id,
        ageGroup: req.age_group,
        baseQuest: topHit.quest,
      });

      // F-003 Task 7 — safetyPipeline 주입 시 modifier 출력에 필터 적용.
      // vector_modify는 원래 store.save를 호출하지 않으므로 blocked 분기에서도 저장 스킵 동작은 기존과 동일.
      if (this.deps.safetyPipeline) {
        const filtered = await this.deps.safetyPipeline.apply({
          quest: modified,
          habitText: req.habit_text,
          worldviewId: req.worldview_id,
          ageGroup: req.age_group,
        });
        return {
          quest: filtered.quest,
          meta: {
            path,
            similarity,
            latency_ms: Date.now() - start,
            filter_result: filtered.filter_result,
            llm_usage: modifierUsage,
          },
        };
      }

      return {
        quest: modified,
        meta: {
          path,
          similarity,
          latency_ms: Date.now() - start,
          llm_usage: modifierUsage,
        },
      };
    }

    // llm_new: 신규 생성 + Vector DB 자동 저장.
    const transformed = await this.deps.transformer.transform(req);

    // F-004 Task 2 — transformer meta에서 LLM usage 부분(model/prompt_tokens/completion_tokens)을
    // 추출해 meta.llm_usage로 전파. latency_ms는 retriever 전체 구간용이 아니라 transform 단독용이므로
    // llm_usage에는 포함하지 않는다.
    const transformerUsage = {
      model: transformed.meta.model,
      prompt_tokens: transformed.meta.prompt_tokens,
      completion_tokens: transformed.meta.completion_tokens,
    };

    // F-003 Task 7 — safetyPipeline 주입 시 LLM 생성 결과에 필터 적용.
    // blocked=true일 때는 차단된 원본 퀘스트가 Vector DB에 영구 저장되지 않도록 save를 스킵한다.
    // safe일 때는 파이프라인 출력 quest(원본 또는 치환된 퀘스트)를 저장한다.
    if (this.deps.safetyPipeline) {
      const filtered = await this.deps.safetyPipeline.apply({
        quest: transformed.quest,
        habitText: req.habit_text,
        worldviewId: req.worldview_id,
        ageGroup: req.age_group,
      });

      if (!filtered.filter_result.blocked) {
        try {
          await this.deps.store.save({
            inputText: req.habit_text,
            worldviewId: req.worldview_id,
            ageGroup: req.age_group,
            embedding,
            quest: filtered.quest,
          });
        } catch (cause) {
          console.warn("[QuestRetriever] Vector DB save failed (ignored):", cause);
        }
      }

      return {
        quest: filtered.quest,
        meta: {
          path: "llm_new",
          similarity,
          latency_ms: Date.now() - start,
          filter_result: filtered.filter_result,
          llm_usage: transformerUsage,
        },
      };
    }

    // safetyPipeline 미주입 — F-002 동작 그대로.
    // 저장 실패는 삼킨다 — 사용자 응답은 성공으로 반환.
    // 1단계의 embedding을 재사용해 재임베딩 비용을 방지한다.
    try {
      await this.deps.store.save({
        inputText: req.habit_text,
        worldviewId: req.worldview_id,
        ageGroup: req.age_group,
        embedding,
        quest: transformed.quest,
      });
    } catch (cause) {
      // 저장은 베스트-에포트. 실패해도 사용자에게는 새 퀘스트를 돌려준다.
      console.warn("[QuestRetriever] Vector DB save failed (ignored):", cause);
    }

    return {
      quest: transformed.quest,
      meta: {
        path: "llm_new",
        similarity,
        latency_ms: Date.now() - start,
        llm_usage: transformerUsage,
      },
    };
  }

  // 경로 분기 규칙을 한 곳에 모아 리팩터/테스트 용이성 확보.
  // - 히트가 없거나 최상위 유사도 < modify → llm_new
  // - modify <= sim < exact              → vector_modify
  // - sim >= exact                       → vector_exact
  private route(topHit: SearchHit | undefined): RoutingPath {
    if (!topHit) {
      return "llm_new";
    }
    if (topHit.similarity >= this.thresholds.exact) {
      return "vector_exact";
    }
    if (topHit.similarity >= this.thresholds.modify) {
      return "vector_modify";
    }
    return "llm_new";
  }
}
