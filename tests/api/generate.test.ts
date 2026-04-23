// F-002 Task 7 — POST /api/quest/generate HTTP 계약 테스트.
// F-004 Task 5 — IntegratedPipelinePort 기반으로 마이그레이션. 응답 메타가
// PRD 확정 스키마(processing_path / safety_check / model_used / tokens / cost)로 교체됨.
//
// - IntegratedPipeline은 vi.fn()으로 모킹 — 실제 캐시/Vector/LLM 호출 없음.
// - Fastify `inject()`로 네트워크 없이 핸들러 직접 호출.
//
// 에러 매핑:
//   Zod 요청 검증 실패 → 400 (pipeline 미호출)
//   pipeline.run이 ParseError → 422
//   pipeline.run이 ValidationError → 422
//   기타 → 500 (내부 디테일 노출 금지)
//
// 회귀 방지: pipeline이 함께 주입돼도 기존 /api/quest/transform이 계속 동작.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServer,
  type TransformerPort,
} from "../../src/api/server.js";
import { ParseError, ValidationError } from "../../src/core/errors.js";
import type { IntegratedPipelinePort } from "../../src/core/pipeline.js";
import {
  GenerateResponseSchema,
  TransformResponseSchema,
  type GenerateResponse,
  type TransformResponse,
} from "../../src/core/schemas/api.js";
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

const VALID_GENERATE_RESPONSE: GenerateResponse = {
  quest: VALID_QUEST,
  meta: {
    processing_path: "vector_exact",
    similarity_score: 0.95,
    safety_check: "passed",
    latency_ms: 120,
    model_used: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    estimated_cost_usd: 0,
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

function newMockPipeline(): IntegratedPipelinePort & {
  run: ReturnType<typeof vi.fn>;
} {
  return { run: vi.fn() };
}

describe("POST /api/quest/generate", () => {
  let transformer: ReturnType<typeof newMockTransformer>;
  let pipeline: ReturnType<typeof newMockPipeline>;

  beforeEach(() => {
    transformer = newMockTransformer();
    pipeline = newMockPipeline();
  });

  it("유효 요청 → 200 + GenerateResponseSchema 통과 (quest + 새 meta 필드 포함)", async () => {
    pipeline.run.mockResolvedValueOnce(VALID_GENERATE_RESPONSE);
    const app = buildServer(transformer, pipeline);

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
      expect(parsed.data.meta.processing_path).toBe("vector_exact");
      expect(parsed.data.meta.similarity_score).toBe(0.95);
      expect(parsed.data.meta.safety_check).toBe("passed");
      expect(parsed.data.meta.latency_ms).toBe(120);
      expect(parsed.data.meta.model_used).toBeNull();
      expect(parsed.data.meta.prompt_tokens).toBe(0);
      expect(parsed.data.meta.completion_tokens).toBe(0);
      expect(parsed.data.meta.estimated_cost_usd).toBe(0);
      expect(parsed.data.quest).toEqual(VALID_QUEST);
    }
    expect(pipeline.run).toHaveBeenCalledTimes(1);
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("habit_text 누락 → 400, pipeline 미호출", async () => {
    const app = buildServer(transformer, pipeline);

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
    expect(pipeline.run).not.toHaveBeenCalled();
  });

  it.each([
    ["../etc/passwd"],
    ["Kingdom_Of_Light"],
  ])("worldview_id 부적격(%s) → 400, pipeline 미호출", async (worldview_id) => {
    const app = buildServer(transformer, pipeline);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: { habit_text: "아침 7시에 일어나기", worldview_id },
    });

    expect(res.statusCode).toBe(400);
    expect(pipeline.run).not.toHaveBeenCalled();
  });

  it("pipeline이 ParseError → 422", async () => {
    pipeline.run.mockRejectedValueOnce(new ParseError("LLM 파싱 실패"));
    const app = buildServer(transformer, pipeline);

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

  it("pipeline이 ValidationError → 422", async () => {
    pipeline.run.mockRejectedValueOnce(
      new ValidationError("Quest 스키마 검증 실패"),
    );
    const app = buildServer(transformer, pipeline);

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
    pipeline.run.mockRejectedValueOnce(
      new Error("INTERNAL_SECRET_STACK_FRAME"),
    );
    const app = buildServer(transformer, pipeline);

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

  it("pipeline 미주입 시 /api/quest/generate 라우트 미등록 → 404", async () => {
    const app = buildServer(transformer); // pipeline 생략

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/generate",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(404);
    expect(pipeline.run).not.toHaveBeenCalled();
  });

  it("회귀 방지: pipeline 함께 주입돼도 /api/quest/transform 계속 동작", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildServer(transformer, pipeline);

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
    expect(pipeline.run).not.toHaveBeenCalled();
  });
});
