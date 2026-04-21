// F-002 Task 4 — VectorStore.
//
// 책임:
// - Supabase JS SDK로 `quest_vectors` 테이블에 임베딩 + quest DTO를 저장한다 (save).
// - `match_quest_vectors` RPC를 호출해 코사인 유사도 상위 N건을 검색한다 (search).
//
// 설계:
// - Supabase 클라이언트는 생성자 주입 (테스트는 페이크 객체로 교체 가능).
// - RPC 파라미터 이름(query_embedding, filter_worldview_id, filter_age_group, match_count)은
//   supabase/migrations/20260421_001_quest_vectors.sql의 함수 시그니처와 정확히 일치한다.
// - RPC 응답의 quest_result JSONB는 QuestSchema.parse로 런타임 검증한다 — LLM 출력 드리프트나
//   스키마 변경이 있을 때 조기에 에러로 노출한다 (embedding.ts의 1536 차원 검증과 동일 원칙).
// - 에러는 어떤 작업(어느 RPC/테이블)이 실패했는지 컨텍스트를 포함해 재-throw 한다.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type Quest, QuestSchema } from "../schemas/quest.js";

export interface SearchHit {
  id: string;
  inputText: string;
  quest: Quest;
  similarity: number;
}

const RPC_NAME = "match_quest_vectors";
const TABLE_NAME = "quest_vectors";
const DEFAULT_MATCH_COUNT = 5;

export class VectorStore {
  constructor(private readonly client: SupabaseClient) {}

  async search(params: {
    embedding: number[];
    worldviewId: string;
    ageGroup: string;
    matchCount?: number;
  }): Promise<SearchHit[]> {
    const { data, error } = await this.client.rpc(RPC_NAME, {
      query_embedding: params.embedding,
      filter_worldview_id: params.worldviewId,
      filter_age_group: params.ageGroup,
      match_count: params.matchCount ?? DEFAULT_MATCH_COUNT,
    });

    if (error) {
      // cause에 PostgrestError를 보존해 downstream 재시도/로깅이 code·details·hint를 참조할 수 있게 한다.
      throw new Error(
        `VectorStore.search: RPC ${RPC_NAME} 호출 실패 — ${error.message}`,
        { cause: error },
      );
    }

    const rows = (data ?? []) as Array<{
      id: string;
      input_text: string;
      quest_result: unknown;
      similarity: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      inputText: row.input_text,
      // JSONB → Quest 런타임 검증. 드리프트 발생 시 ZodError로 즉시 실패.
      quest: QuestSchema.parse(row.quest_result),
      similarity: row.similarity,
    }));
  }

  async save(params: {
    inputText: string;
    worldviewId: string;
    ageGroup: string;
    embedding: number[];
    quest: Quest;
    isSeed?: boolean;
  }): Promise<{ id: string }> {
    const payload = {
      input_text: params.inputText,
      worldview_id: params.worldviewId,
      age_group: params.ageGroup,
      embedding: params.embedding,
      quest_result: params.quest,
      is_seed: params.isSeed ?? false,
    };

    const { data, error } = await this.client
      .from(TABLE_NAME)
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      // cause에 PostgrestError를 보존해 downstream 재시도/로깅이 code·details·hint를 참조할 수 있게 한다.
      throw new Error(
        `VectorStore.save: ${TABLE_NAME} INSERT 실패 — ${error.message}`,
        { cause: error },
      );
    }
    if (!data) {
      throw new Error(
        `VectorStore.save: ${TABLE_NAME} INSERT 응답에 id가 없습니다`,
      );
    }

    const { id } = data as { id: string };
    return { id };
  }
}
