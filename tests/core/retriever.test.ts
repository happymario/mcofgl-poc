// F-002 Task 6 — QuestRetriever 3단계 체인 계약 테스트.
//
// 설계:
// - 의존성 4개(EmbeddingService / VectorStore / LightModifier / QuestTransformer)는
//   생성자 주입이므로 vi.mock 없이 `vi.fn()` 페이크 객체로 교체한다.
//   (참고: tests/core/vector/store.test.ts의 SupabaseFake 패턴)
// - 유사도 기반 경로 분기(≥0.9 exact / 0.7~0.9 modify / <0.7 new+save)를
//   검증한다.
// - `embed`는 특정 벡터로 resolve하도록 만들어 llm_new 경로에서 저장 시
//   동일한 임베딩이 재사용되는지(재임베딩 비용 방지)를 assertion으로 확인한다.
// - 저장 실패(store.save reject)는 삼켜지고 사용자 응답은 성공해야 한다.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingService } from "../../src/core/vector/embedding.js";
import type { LightModifier } from "../../src/core/modifier.js";
import { QuestRetriever } from "../../src/core/retriever.js";
import type { TransformRequest } from "../../src/core/schemas/api.js";
import type { Quest } from "../../src/core/schemas/quest.js";
import type { QuestTransformer } from "../../src/core/transformer.js";
import type { SearchHit, VectorStore } from "../../src/core/vector/store.js";

// 반복 사용 픽스처.
const STORED_QUEST: Quest = {
  quest_name: "빛의 서약 실행",
  description: "아침에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
};

const MODIFIED_QUEST: Quest = {
  ...STORED_QUEST,
  quest_name: "빛의 서약 - 이른 기상편",
  description: "새벽 6시 30분에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  original_habit: "새벽 6시 30분에 일어나기",
};

const GENERATED_QUEST: Quest = {
  ...STORED_QUEST,
  quest_name: "새로운 모험의 시작",
  description: "완전히 새로운 습관을 수행한다.",
  original_habit: "전혀 다른 새 습관",
};

const BASE_REQUEST: TransformRequest = {
  habit_text: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
  age_group: "7-12",
  regenerate: false,
};

// embed 페이크가 반환할 고유 벡터 — save 호출 시 재사용 검증용.
const EMBED_VECTOR = new Array(1536).fill(0.42);

function makeHit(similarity: number): SearchHit {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    inputText: "아침 7시 기상",
    quest: STORED_QUEST,
    similarity,
  };
}

type EmbeddingFake = { embed: ReturnType<typeof vi.fn> };
type StoreFake = {
  search: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};
type ModifierFake = { modify: ReturnType<typeof vi.fn> };
type TransformerFake = { transform: ReturnType<typeof vi.fn> };

function buildFakes(): {
  embedding: EmbeddingFake;
  store: StoreFake;
  modifier: ModifierFake;
  transformer: TransformerFake;
} {
  return {
    embedding: { embed: vi.fn().mockResolvedValue(EMBED_VECTOR) },
    store: {
      search: vi.fn(),
      save: vi.fn().mockResolvedValue({ id: "saved-id" }),
    },
    modifier: { modify: vi.fn() },
    transformer: { transform: vi.fn() },
  };
}

function buildRetriever(fakes: ReturnType<typeof buildFakes>): QuestRetriever {
  return new QuestRetriever({
    embedding: fakes.embedding as unknown as EmbeddingService,
    store: fakes.store as unknown as VectorStore,
    modifier: fakes.modifier as unknown as LightModifier,
    transformer: fakes.transformer as unknown as QuestTransformer,
  });
}

describe("QuestRetriever", () => {
  let fakes: ReturnType<typeof buildFakes>;

  beforeEach(() => {
    fakes = buildFakes();
  });

  it("sim=0.95 → vector_exact: modifier/transformer/save를 호출하지 않고 original_habit/worldview_id 강제 주입 후 반환", async () => {
    fakes.store.search.mockResolvedValueOnce([makeHit(0.95)]);

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    // original_habit/worldview_id는 저장된 seed 값이 아니라 요청값으로 덮어써야 함 (F-001 계약)
    expect(result.quest.original_habit).toBe(BASE_REQUEST.habit_text);
    expect(result.quest.worldview_id).toBe(BASE_REQUEST.worldview_id);
    // 나머지 필드는 저장된 quest를 그대로 유지
    expect(result.quest.quest_name).toBe(STORED_QUEST.quest_name);
    expect(result.meta.path).toBe("vector_exact");
    expect(result.meta.similarity).toBe(0.95);
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);

    expect(fakes.embedding.embed).toHaveBeenCalledTimes(1);
    expect(fakes.store.search).toHaveBeenCalledTimes(1);
    expect(fakes.modifier.modify).not.toHaveBeenCalled();
    expect(fakes.transformer.transform).not.toHaveBeenCalled();
    expect(fakes.store.save).not.toHaveBeenCalled();
  });

  it("sim=0.82 → vector_modify: modifier.modify 호출 (top hit quest 전달), transformer/save 미호출", async () => {
    const topHit = makeHit(0.82);
    fakes.store.search.mockResolvedValueOnce([topHit]);
    fakes.modifier.modify.mockResolvedValueOnce(MODIFIED_QUEST);

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.quest).toEqual(MODIFIED_QUEST);
    expect(result.meta.path).toBe("vector_modify");
    expect(result.meta.similarity).toBe(0.82);

    expect(fakes.modifier.modify).toHaveBeenCalledTimes(1);
    expect(fakes.modifier.modify).toHaveBeenCalledWith(
      expect.objectContaining({
        baseQuest: topHit.quest,
        habitText: BASE_REQUEST.habit_text,
        worldviewId: BASE_REQUEST.worldview_id,
        ageGroup: BASE_REQUEST.age_group,
      }),
    );
    expect(fakes.transformer.transform).not.toHaveBeenCalled();
    expect(fakes.store.save).not.toHaveBeenCalled();
  });

  it("히트 없음(data=[]) → llm_new: transformer.transform 호출, store.save 호출 (임베딩 재사용), similarity=null", async () => {
    fakes.store.search.mockResolvedValueOnce([]);
    fakes.transformer.transform.mockResolvedValueOnce({
      quest: GENERATED_QUEST,
      meta: { model: "test", latency_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
    });

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.quest).toEqual(GENERATED_QUEST);
    expect(result.meta.path).toBe("llm_new");
    expect(result.meta.similarity).toBeNull();
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);

    // embed는 단 한 번만 호출되어야 한다 (save 시 재임베딩 금지).
    expect(fakes.embedding.embed).toHaveBeenCalledTimes(1);

    expect(fakes.transformer.transform).toHaveBeenCalledTimes(1);
    expect(fakes.transformer.transform).toHaveBeenCalledWith(BASE_REQUEST);

    expect(fakes.store.save).toHaveBeenCalledTimes(1);
    expect(fakes.store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        inputText: BASE_REQUEST.habit_text,
        worldviewId: BASE_REQUEST.worldview_id,
        ageGroup: BASE_REQUEST.age_group,
        // 1단계에서 얻은 임베딩 벡터가 그대로 재사용되어야 함.
        embedding: EMBED_VECTOR,
        quest: GENERATED_QUEST,
      }),
    );
    expect(fakes.modifier.modify).not.toHaveBeenCalled();
  });

  it("최고 sim=0.65 → llm_new: 동일 경로, similarity는 null이 아닌 0.65 (top hit 값)", async () => {
    fakes.store.search.mockResolvedValueOnce([makeHit(0.65)]);
    fakes.transformer.transform.mockResolvedValueOnce({
      quest: GENERATED_QUEST,
      meta: { model: "test", latency_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
    });

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.meta.path).toBe("llm_new");
    // 히트는 존재하므로 similarity는 top hit 값, null이 아니다.
    expect(result.meta.similarity).toBe(0.65);
    expect(fakes.transformer.transform).toHaveBeenCalledTimes(1);
    expect(fakes.store.save).toHaveBeenCalledTimes(1);
    expect(fakes.modifier.modify).not.toHaveBeenCalled();
  });

  it("meta 필드 구조: path / similarity / latency_ms를 모두 포함한다", async () => {
    fakes.store.search.mockResolvedValueOnce([makeHit(0.95)]);

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.meta).toHaveProperty("path");
    expect(result.meta).toHaveProperty("similarity");
    expect(result.meta).toHaveProperty("latency_ms");
    expect(typeof result.meta.latency_ms).toBe("number");
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("경계값: sim=0.9 → vector_exact (>= 0.9)", async () => {
    fakes.store.search.mockResolvedValueOnce([makeHit(0.9)]);

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.meta.path).toBe("vector_exact");
    expect(result.meta.similarity).toBe(0.9);
    expect(fakes.modifier.modify).not.toHaveBeenCalled();
    expect(fakes.transformer.transform).not.toHaveBeenCalled();
    expect(fakes.store.save).not.toHaveBeenCalled();
  });

  it("경계값: sim=0.7 → vector_modify (>= 0.7 & < 0.9)", async () => {
    fakes.store.search.mockResolvedValueOnce([makeHit(0.7)]);
    fakes.modifier.modify.mockResolvedValueOnce(MODIFIED_QUEST);

    const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

    expect(result.meta.path).toBe("vector_modify");
    expect(result.meta.similarity).toBe(0.7);
    expect(fakes.modifier.modify).toHaveBeenCalledTimes(1);
    expect(fakes.transformer.transform).not.toHaveBeenCalled();
    expect(fakes.store.save).not.toHaveBeenCalled();
  });

  it("llm_new 경로에서 store.save가 실패해도 사용자 응답은 성공으로 반환된다", async () => {
    fakes.store.search.mockResolvedValueOnce([]);
    fakes.transformer.transform.mockResolvedValueOnce({
      quest: GENERATED_QUEST,
      meta: { model: "test", latency_ms: 0, prompt_tokens: 0, completion_tokens: 0 },
    });
    fakes.store.save.mockRejectedValueOnce(new Error("insert failed"));

    // 실패가 무음으로 "삼켜지지" 않았음을 검증 (경고 로그 1회 이상).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // reject 하지 않고 성공 응답이 반환되어야 한다.
      const result = await buildRetriever(fakes).retrieve(BASE_REQUEST);

      expect(result.quest).toEqual(GENERATED_QUEST);
      expect(result.meta.path).toBe("llm_new");
      expect(fakes.store.save).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
