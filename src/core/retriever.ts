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
import type { TransformRequest } from "./schemas/api.js";
import type { Quest } from "./schemas/quest.js";
import type { QuestTransformer } from "./transformer.js";
import type { EmbeddingService } from "./vector/embedding.js";
import type { SearchHit, VectorStore } from "./vector/store.js";

export type RoutingPath = "vector_exact" | "vector_modify" | "llm_new";

export interface RetrieveMeta {
  path: RoutingPath;
  similarity: number | null;
  latency_ms: number;
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
      const modified = await this.deps.modifier.modify({
        habitText: req.habit_text,
        worldviewId: req.worldview_id,
        ageGroup: req.age_group,
        baseQuest: topHit.quest,
      });
      return {
        quest: modified,
        meta: { path, similarity, latency_ms: Date.now() - start },
      };
    }

    // llm_new: 신규 생성 + Vector DB 자동 저장.
    const transformed = await this.deps.transformer.transform(req);
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
      meta: { path: "llm_new", similarity, latency_ms: Date.now() - start },
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
