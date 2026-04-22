// F-002 Task 7 — POST /api/quest/generate HTTP 계약 테스트.
//
// - QuestRetriever는 vi.fn()으로 모킹 — 실제 임베딩/Supabase 호출 없음.
// - Fastify `inject()`로 네트워크 없이 핸들러 직접 호출.
//
// 에러 매핑:
//   Zod 요청 검증 실패 → 400 (retriever 미호출)
//   retriever가 ParseError → 422
//   retriever가 ValidationError → 422
//   기타 → 500 (내부 디테일 노출 금지)
//
// 회귀 방지: retriever가 함께 주입돼도 기존 /api/quest/transform이 계속 동작.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServer,
  type RetrieverPort,
  type TransformerPort,
} from "../../src/api/server.js";
import { ParseError, ValidationError } from "../../src/core/errors.js";
import {
  GenerateResponseSchema,
  TransformResponseSchema,
  type TransformResponse,
} from "../../src/core/schemas/api.js";
import type { RetrieveResult } from "../../src/core/retriever.js";
import type { Quest } from "../../src/core/schemas/quest.js";

const VALID_QUEST: Quest = {
  quest_name: "새벽의 서약",
  description: "아침에 일어나 서약을 외친다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2 },
  reward: { exp: 20, coin: 5 },
  suggested_grade: "D",
  mandatory_suitability: "high",
  original_habit: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
};

const VALID_RETRIEVE_RESULT: RetrieveResult = {
  quest: VALID_QUEST,
  meta: {
    path: "vector_exact",
    similarity: 0.95,
    latency_ms: 120,
  },
};

const VALID_TRANSFORM_RESPONSE: TransformResponse = {
  quest: VALID_QUEST,
  meta: {
    model: "claude-haiku-test",
    latency_ms: 1200,
    prompt_tokens: 800,
    completion_tokens: 150,
  },
};

const VALID_REQUEST_BODY = {
  habit_text: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
  age_group: "7-12",
};

function newMockTransformer(): TransformerPort & {
  transform: ReturnType<typeof vi.fn>;
} {
  return { transform: vi.fn() };
}

function newMockRetriever(): RetrieverPort & {
  retrieve: ReturnType<typeof vi.fn>;
} {
  return { retrieve: vi.fn() };
}

describe("POST /api/quest/generate", () => {
  let transformer: ReturnType<typeof newMockTransformer>;
  let retriever: ReturnType<typeof newMockRetriever>;

  beforeEach(() => {
    transformer = newMockTransformer();
    retriever = newMockRetriever();
  });

  it("유효 요청 → 200 + GenerateResponseSchema 통과 (quest + meta 포함)", async () => {
    retriever.retrieve.mockResolvedValueOnce(VALID_RETRIEVE_RESULT);
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body: unknown = JSON.parse(res.payload);
    const parsed = GenerateResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meta.path).toBe("vector_exact");
      expect(parsed.data.meta.similarity).toBe(0.95);
      expect(parsed.data.meta.latency_ms).toBe(120);
      expect(parsed.data.quest).toEqual(VALID_QUEST);
    }
    expect(retriever.retrieve).toHaveBeenCalledTimes(1);
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("habit_text 누락 → 400, retriever 미호출", async () => {
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: {
        worldview_id: "kingdom_of_light",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ["../etc/passwd"],
    ["Kingdom_Of_Light"],
  ])("worldview_id 부적격(%s) → 400, retriever 미호출", async (worldview_id) => {
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: { habit_text: "아침 7시에 일어나기", worldview_id },
    });

    expect(res.statusCode).toBe(400);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it("retriever가 ParseError → 422", async () => {
    retriever.retrieve.mockRejectedValueOnce(new ParseError("LLM 파싱 실패"));
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
  });

  it("retriever가 ValidationError → 422", async () => {
    retriever.retrieve.mockRejectedValueOnce(
      new ValidationError("Quest 스키마 검증 실패"),
    );
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
  });

  it("기타 예외 → 500, 내부 에러 상세가 응답에 노출되지 않는다", async () => {
    retriever.retrieve.mockRejectedValueOnce(
      new Error("INTERNAL_SECRET_STACK_FRAME"),
    );
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("내부 서버 오류");
    expect(res.payload).not.toContain("INTERNAL_SECRET_STACK_FRAME");
  });

  it("retriever 미주입 시 /api/quest/generate 라우트 미등록 → 404", async () => {
    const app = buildServer(transformer); // retriever 생략

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(404);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it("회귀 방지: retriever 함께 주입돼도 /api/quest/transform 계속 동작", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildServer(transformer, retriever);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(200);
    const parsed = TransformResponseSchema.safeParse(JSON.parse(res.payload));
    expect(parsed.success).toBe(true);
    expect(transformer.transform).toHaveBeenCalledTimes(1);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });
});
