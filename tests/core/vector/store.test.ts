// F-002 Task 4 — VectorStore 계약 테스트.
//
// - Supabase 클라이언트는 생성자 주입이므로 vi.mock 없이 페이크 객체로 교체한다.
// - RPC 파라미터 이름(query_embedding, filter_worldview_id, filter_age_group, match_count)은
//   Task 2 SQL(supabase/migrations/20260421_001_quest_vectors.sql)과 정확히 일치해야 한다.
// - RPC 응답의 snake_case(input_text, quest_result)는 SearchHit의 camelCase로 매핑한다.
// - quest_result JSONB는 QuestSchema.parse로 런타임 검증한다 (embedding.ts의 차원 검증과 동일 원칙).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Quest } from "../../../src/core/schemas/quest.js";
import { VectorStore } from "../../../src/core/vector/store.js";

// 정상 Quest 픽스처 — QuestSchema.parse를 통과해야 함.
const sampleQuest: Quest = {
  quest_name: "아침 기상의 의식",
  description: "아침에 일어나 하루를 시작한다",
  category: "기상/취침",
  stat_mapping: { 체력: 5 },
  reward: { exp: 10, coin: 5 },
  suggested_grade: "D",
  mandatory_suitability: "high",
  original_habit: "아침 7시 기상",
  worldview_id: "fantasy",
};

// .insert(payload).select('id').single() 체인의 최종 해석 결과를 리턴하는 페이크.
function buildInsertChain(resolveValue: {
  data: { id: string } | null;
  error: { message: string } | null;
}) {
  const single = vi.fn().mockResolvedValue(resolveValue);
  const select = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockReturnValue({ select });
  return { insert, select, single };
}

type SupabaseFake = {
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
};

function buildClient(): SupabaseFake {
  return {
    rpc: vi.fn(),
    from: vi.fn(),
  };
}

describe("VectorStore", () => {
  let client: SupabaseFake;

  beforeEach(() => {
    client = buildClient();
  });

  describe("search", () => {
    it("RPC가 반환한 quest_result가 QuestSchema와 불일치하면 ZodError로 실패한다", async () => {
      client.rpc.mockResolvedValueOnce({
        data: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            input_text: "아침 7시 기상",
            quest_result: { quest_name: "부분 객체만 있는 잘못된 quest" },
            similarity: 0.92,
          },
        ],
        error: null,
      });

      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);
      await expect(
        store.search({
          embedding: new Array(1536).fill(0),
          worldviewId: "fantasy",
          ageGroup: "5-7",
        }),
      ).rejects.toThrow();
    });

    it("RPC 응답 배열을 SearchHit[]으로 매핑한다 (snake_case → camelCase)", async () => {
      client.rpc.mockResolvedValueOnce({
        data: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            input_text: "아침 7시 기상",
            quest_result: sampleQuest,
            similarity: 0.92,
          },
        ],
        error: null,
      });

      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);
      const hits = await store.search({
        embedding: new Array(1536).fill(0),
        worldviewId: "fantasy",
        ageGroup: "5-7",
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]).toEqual({
        id: "11111111-1111-1111-1111-111111111111",
        inputText: "아침 7시 기상",
        quest: sampleQuest,
        similarity: 0.92,
      });
    });

    it("RPC 에러 응답이 오면 Error를 throw 한다", async () => {
      client.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: "connection refused" },
      });

      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);

      await expect(
        store.search({
          embedding: new Array(1536).fill(0),
          worldviewId: "fantasy",
          ageGroup: "5-7",
        }),
      ).rejects.toThrow(/connection refused/);
    });

    it("기본 match_count=5로 호출되며, matchCount 인자가 주어지면 그 값으로 전달된다", async () => {
      client.rpc.mockResolvedValue({ data: [], error: null });
      const embedding = new Array(1536).fill(0.1);
      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);

      // 기본값 케이스
      await store.search({
        embedding,
        worldviewId: "fantasy",
        ageGroup: "5-7",
      });
      expect(client.rpc).toHaveBeenLastCalledWith("match_quest_vectors", {
        query_embedding: embedding,
        filter_worldview_id: "fantasy",
        filter_age_group: "5-7",
        match_count: 5,
      });

      // 오버라이드 케이스
      await store.search({
        embedding,
        worldviewId: "fantasy",
        ageGroup: "5-7",
        matchCount: 3,
      });
      expect(client.rpc).toHaveBeenLastCalledWith("match_quest_vectors", {
        query_embedding: embedding,
        filter_worldview_id: "fantasy",
        filter_age_group: "5-7",
        match_count: 3,
      });
    });
  });

  describe("save", () => {
    it("insert 페이로드에 embedding 배열과 quest_result JSONB, is_seed=false 기본값이 담긴다", async () => {
      const chain = buildInsertChain({
        data: { id: "22222222-2222-2222-2222-222222222222" },
        error: null,
      });
      client.from.mockReturnValue({ insert: chain.insert });

      const embedding = new Array(1536).fill(0.5);
      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);

      const result = await store.save({
        inputText: "아침 7시 기상",
        worldviewId: "fantasy",
        ageGroup: "5-7",
        embedding,
        quest: sampleQuest,
      });

      expect(client.from).toHaveBeenCalledWith("quest_vectors");
      expect(chain.insert).toHaveBeenCalledTimes(1);
      expect(chain.insert.mock.calls[0]?.[0]).toEqual({
        input_text: "아침 7시 기상",
        worldview_id: "fantasy",
        age_group: "5-7",
        embedding,
        quest_result: sampleQuest,
        is_seed: false,
      });
      expect(result).toEqual({ id: "22222222-2222-2222-2222-222222222222" });
    });

    it("isSeed=true로 호출하면 insert 페이로드에 is_seed=true가 포함된다", async () => {
      const chain = buildInsertChain({
        data: { id: "33333333-3333-3333-3333-333333333333" },
        error: null,
      });
      client.from.mockReturnValue({ insert: chain.insert });

      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);

      await store.save({
        inputText: "시드 습관",
        worldviewId: "fantasy",
        ageGroup: "5-7",
        embedding: new Array(1536).fill(0),
        quest: sampleQuest,
        isSeed: true,
      });

      expect(chain.insert.mock.calls[0]?.[0]).toMatchObject({
        is_seed: true,
      });
    });

    it("insert 실패 시 Error를 throw 한다", async () => {
      const chain = buildInsertChain({
        data: null,
        error: { message: "unique violation" },
      });
      client.from.mockReturnValue({ insert: chain.insert });

      // biome-ignore lint/suspicious/noExplicitAny: 페이크 클라이언트를 SupabaseClient로 단언
      const store = new VectorStore(client as any);

      await expect(
        store.save({
          inputText: "중복",
          worldviewId: "fantasy",
          ageGroup: "5-7",
          embedding: new Array(1536).fill(0),
          quest: sampleQuest,
        }),
      ).rejects.toThrow(/unique violation/);
    });
  });
});
