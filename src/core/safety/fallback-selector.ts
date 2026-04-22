// F-003 Task 5 — FallbackSelector: 차단된 퀘스트를 안전한 대체 퀘스트로 교체.
//
// 처리 알고리즘 (스펙 §3.3):
//   1) habit_text를 EmbeddingService로 임베딩.
//   2) VectorStore.search(worldviewId, ageGroup)로 유사도 상위 N건 조회.
//   3) 결과 중 is_seed=true인 최상위 1건을 찾아 그 quest 반환.
//   4) is_seed=true가 하나도 없으면 → 빌트인 범용 퀘스트.
//   5) search가 throw해도 → 빌트인 범용 퀘스트 (부분 장애가 파이프라인 전체를 막지 않는다).
//   6) 세계관에 빌트인 퀘스트가 없으면 → Error throw (상위 pipeline이 fail-closed 처리).
//
// 설계:
// - EmbeddingService / VectorStore는 생성자 주입 — 테스트에서 vi.fn()으로 쉽게 교체.
// - search 실패는 내부적으로 swallow해 빌트인으로 폴백하지만, 알 수 없는 worldview_id는
//   명시적으로 throw해 운영상 누락이 있음을 드러낸다.
// - is_seed 필터는 RPC에서 하지 않고 코드에서 수행한다 — RPC가 is_seed를 반환하기 전의
//   마이그레이션 공백 기간에도 코드가 동작할 수 있도록 (SearchHit.is_seed는 ?? false).
// - 현재 단계에서는 VectorStore.search 결과가 유사도 내림차순임을 전제로 "Array.find"
//   첫 매치를 상위로 간주한다. (스펙 §3.3 "유사도 최상위 1건".)

import type { Quest } from "../schemas/quest.js";
import type { EmbeddingService } from "../vector/embedding.js";
import type { VectorStore } from "../vector/store.js";
import { getBuiltinFallbackQuest } from "./fallback-quests.js";

export interface FallbackSelectorParams {
  habitText: string;
  worldviewId: string;
  ageGroup: string;
}

export class FallbackSelector {
  constructor(
    private readonly embedding: EmbeddingService,
    private readonly store: VectorStore,
  ) {}

  async select(params: FallbackSelectorParams): Promise<Quest> {
    const { habitText, worldviewId, ageGroup } = params;

    // Phase 1: 임베딩 + 유사도 검색. 어느 단계든 throw하면 빌트인으로 폴백.
    try {
      const vector = await this.embedding.embed(habitText);
      const hits = await this.store.search({
        embedding: vector,
        worldviewId,
        ageGroup,
      });

      // Phase 2: is_seed=true 상위 1건 반환.
      // VectorStore.search는 RPC에서 ORDER BY 유사도를 수행하므로
      // 배열 순서상 앞쪽이 유사도 상위이며, find로 첫 seed를 뽑으면 된다.
      const topSeed = hits.find((h) => h.is_seed);
      if (topSeed) {
        return topSeed.quest;
      }
      // Phase 3: seed 히트 없음 → 빌트인 폴백.
    } catch (cause) {
      // fail-open to builtin: store 장애가 전체 파이프라인을 막지 않도록 한다.
      // 운영 상황을 놓치지 않게 명시적으로 로깅한다.
      console.error(
        `[FallbackSelector] 유사도 검색 실패 → 빌트인 폴백으로 진행 (habitText=${habitText})`,
        cause,
      );
    }

    // Phase 4: 빌트인 범용 퀘스트. 모르는 worldview_id면 여기서 Error throw.
    return getBuiltinFallbackQuest(worldviewId, habitText);
  }
}
