// 스펙 §F-003 Task 5 — FallbackSelector 계약 테스트.
//
// 폴백 선택 알고리즘 (스펙 §3.3):
//   1) habit_text → 임베딩 → VectorStore.search
//   2) 검색 결과 중 is_seed=true 상위 1건 → quest 반환
//   3) seed 히트 없으면 → getBuiltinFallbackQuest(worldviewId, habitText)
//   4) store가 throw해도 → 빌트인 폴백 (fail-open to builtin)
//   5) 모르는 worldview_id → Error throw (상위 파이프라인이 fail-closed 처리)
//
// 주요 불변:
// - FallbackSelector는 EmbeddingService와 VectorStore를 생성자 주입받아 테스트에서
//   vi.fn() 페이크로 교체 가능하다.
// - 빌트인 퀘스트는 QuestSchema.parse를 즉시 통과한다 (완료 기준 보강 smoke).

import { describe, expect, it, vi } from "vitest";
import { FallbackSelector } from "../../../src/core/safety/fallback-selector.js";
import { getBuiltinFallbackQuest } from "../../../src/core/safety/fallback-quests.js";
import type { Quest } from "../../../src/core/schemas/quest.js";
import { QuestSchema } from "../../../src/core/schemas/quest.js";
import type { EmbeddingService } from "../../../src/core/vector/embedding.js";
import type { SearchHit, VectorStore } from "../../../src/core/vector/store.js";

// sampleQuest — QuestSchema 전체 필드를 충족하는 정상 픽스처.
function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    quest_name: "아침 기상의 의식",
    description: "아침에 일어나 하루를 시작한다",
    category: "기상/취침",
    stat_mapping: { 체력: 5 },
    reward: { exp: 10, coin: 5 },
    suggested_grade: "D",
    mandatory_suitability: "high",
    original_habit: "아침 7시 기상",
    worldview_id: "kingdom_of_light",
    ...overrides,
  };
}

function makeHit(overrides: Partial<SearchHit>): SearchHit {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    inputText: "기본 habit",
    quest: makeQuest(),
    similarity: 0.8,
    is_seed: false,
    ...overrides,
  };
}

// EmbeddingService/VectorStore를 vi.fn() 페이크로 묶어 반환한다.
function makeSelector(opts: {
  searchImpl: ReturnType<typeof vi.fn>;
}): { selector: FallbackSelector; embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn().mockResolvedValue(new Array(1536).fill(0));
  const fakeEmbedding = { embed } as unknown as EmbeddingService;
  const fakeStore = { search: opts.searchImpl } as unknown as VectorStore;
  const selector = new FallbackSelector(fakeEmbedding, fakeStore);
  return { selector, embed };
}

describe("FallbackSelector.select", () => {
  it("1) seed 히트 있음 → 상위 seed 퀘스트 반환", async () => {
    const seedQuest = makeQuest({ quest_name: "시드 퀘스트", description: "시드 설명" });
    const nonSeedQuest = makeQuest({ quest_name: "일반 퀘스트", description: "일반 설명" });

    const search = vi.fn().mockResolvedValue([
      makeHit({ id: "hit-1", quest: nonSeedQuest, similarity: 0.95, is_seed: false }),
      makeHit({ id: "hit-2", quest: seedQuest, similarity: 0.9, is_seed: true }),
      makeHit({ id: "hit-3", quest: makeQuest({ quest_name: "다른 시드" }), similarity: 0.7, is_seed: true }),
    ]);

    const { selector, embed } = makeSelector({ searchImpl: search });

    const result = await selector.select({
      habitText: "아침 7시 기상",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-9",
    });

    expect(embed).toHaveBeenCalledWith("아침 7시 기상");
    expect(search).toHaveBeenCalledTimes(1);
    // is_seed=true 중 search 결과에서 가장 먼저 나오는(=유사도 상위) 항목을 반환.
    expect(result).toEqual(seedQuest);
  });

  it("2) search 결과 전부 non-seed → 빌트인 폴백 퀘스트 반환", async () => {
    const search = vi.fn().mockResolvedValue([
      makeHit({ is_seed: false, quest: makeQuest({ quest_name: "A" }) }),
      makeHit({ is_seed: false, quest: makeQuest({ quest_name: "B" }) }),
    ]);

    const { selector } = makeSelector({ searchImpl: search });

    const result = await selector.select({
      habitText: "저녁 양치",
      worldviewId: "kingdom_of_light",
      ageGroup: "7-9",
    });

    expect(result).toEqual(getBuiltinFallbackQuest("kingdom_of_light", "저녁 양치"));
  });

  it("3) store.search throw → 빌트인 폴백 퀘스트 반환 (fail-open to builtin)", async () => {
    const search = vi.fn().mockRejectedValue(new Error("RPC timeout"));

    const { selector } = makeSelector({ searchImpl: search });

    const result = await selector.select({
      habitText: "손 씻기",
      worldviewId: "starlight_magic_school",
      ageGroup: "7-9",
    });

    expect(result).toEqual(
      getBuiltinFallbackQuest("starlight_magic_school", "손 씻기"),
    );
  });

  it("4) 모르는 worldview_id → 빌트인 조회 단계에서 Error throw", async () => {
    // search가 빈 결과를 돌려주면 빌트인 단계로 진입하고, 거기서 Error가 발생한다.
    const search = vi.fn().mockResolvedValue([]);

    const { selector } = makeSelector({ searchImpl: search });

    await expect(
      selector.select({
        habitText: "아무 습관",
        worldviewId: "unknown_world",
        ageGroup: "7-9",
      }),
    ).rejects.toThrow(/unknown_world/);
  });
});

describe("getBuiltinFallbackQuest", () => {
  it("빌트인 퀘스트는 QuestSchema.parse를 통과한다 (완료 기준 smoke)", () => {
    const quest = getBuiltinFallbackQuest("kingdom_of_light", "아침 7시 기상");
    expect(() => QuestSchema.parse(quest)).not.toThrow();

    const quest2 = getBuiltinFallbackQuest("starlight_magic_school", "아침 7시 기상");
    expect(() => QuestSchema.parse(quest2)).not.toThrow();
  });
});
