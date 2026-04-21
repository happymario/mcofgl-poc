// F-001 Task 7 — Fastify 서버 HTTP 계약 테스트.
//
// - 스펙 §3.4 HTTP 계약 (요청/응답 스키마, 에러 매핑) 검증.
// - QuestTransformer는 vi.fn()으로 모킹 — 실제 Anthropic 호출 없음.
// - Fastify `inject()`로 네트워크 없이 핸들러를 직접 호출한다.
//
// 에러 매핑:
//   Zod 요청 검증 실패 → 400
//   transformer가 ParseError → 422
//   transformer가 ValidationError → 422
//   기타 → 500

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer, type TransformerPort } from "../../src/api/server.js";
import { ParseError, ValidationError } from "../../src/core/errors.js";
import {
  TransformResponseSchema,
  type TransformResponse,
} from "../../src/core/schemas/api.js";

const VALID_TRANSFORM_RESPONSE: TransformResponse = {
  quest: {
    quest_name: "새벽의 서약",
    description: "아침에 일어나 서약을 외친다.",
    category: "기상/취침",
    stat_mapping: { 체력: 2 },
    reward: { exp: 20, coin: 5 },
    suggested_grade: "D",
    mandatory_suitability: "high",
    original_habit: "아침 7시에 일어나기",
    worldview_id: "kingdom_of_light",
  },
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

function buildApp(transformer: TransformerPort) {
  return buildServer(transformer);
}

describe("POST /api/quest/transform", () => {
  let transformer: ReturnType<typeof newMockTransformer>;

  beforeEach(() => {
    transformer = newMockTransformer();
  });

  it("유효 요청 → 200 + TransformResponseSchema를 통과한다", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body: unknown = JSON.parse(res.payload);
    const parsed = TransformResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(transformer.transform).toHaveBeenCalledTimes(1);
  });

  it("worldview_id 누락 → 400", async () => {
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: { habit_text: "아침 7시에 일어나기" },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("habit_text 빈 문자열 → 400", async () => {
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: {
        habit_text: "",
        worldview_id: "kingdom_of_light",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("transformer가 ParseError → 422", async () => {
    transformer.transform.mockRejectedValueOnce(new ParseError("LLM 파싱 실패"));
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
  });

  it("transformer가 ValidationError → 422", async () => {
    transformer.transform.mockRejectedValueOnce(
      new ValidationError("Quest 스키마 검증 실패"),
    );
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(typeof body.error).toBe("string");
  });

  it("character_context 포함 → 200 정상 처리", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: {
        ...VALID_REQUEST_BODY,
        character_context: { name: "용사", class: "전사", level: 3 },
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = TransformResponseSchema.safeParse(JSON.parse(res.payload));
    expect(parsed.success).toBe(true);
    const call = transformer.transform.mock.calls[0]?.[0];
    expect(call.character_context).toEqual({ name: "용사", class: "전사", level: 3 });
  });

  it("regenerate=true → 200 정상 처리", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: { ...VALID_REQUEST_BODY, regenerate: true },
    });

    expect(res.statusCode).toBe(200);
    const parsed = TransformResponseSchema.safeParse(JSON.parse(res.payload));
    expect(parsed.success).toBe(true);
    const call = transformer.transform.mock.calls[0]?.[0];
    expect(call.regenerate).toBe(true);
  });

  it("기타 예외 → 500, 내부 에러 상세가 응답에 노출되지 않는다", async () => {
    transformer.transform.mockRejectedValueOnce(new Error("INTERNAL_SECRET_STACK_FRAME"));
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe("내부 서버 오류");
    expect(res.payload).not.toContain("INTERNAL_SECRET_STACK_FRAME");
  });

  it.each([
    ["../etc/passwd"],
    ["kingdom of light"],
    ["Kingdom_Of_Light"],
  ])("worldview_id 부적격(%s) → 400, transformer 미호출", async (worldview_id) => {
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: { habit_text: "아침 7시", worldview_id },
    });

    expect(res.statusCode).toBe(400);
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("잘못된 JSON 본문 → 400, transformer 미호출", async () => {
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });

    expect(res.statusCode).toBe(400);
    expect(transformer.transform).not.toHaveBeenCalled();
  });

  it("응답에 meta 필드가 존재한다 (model, latency_ms, prompt_tokens, completion_tokens)", async () => {
    transformer.transform.mockResolvedValueOnce(VALID_TRANSFORM_RESPONSE);
    const app = buildApp(transformer);

    const res = await app.inject({
      method: "POST",
      url: "/api/quest/transform",
      headers: { "content-type": "application/json" },
      payload: VALID_REQUEST_BODY,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.meta).toMatchObject({
      model: expect.any(String),
      latency_ms: expect.any(Number),
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
    });
  });
});
