import { z } from "zod";
import { QuestSchema } from "./quest.js";

// 스펙 §3.1 — /transform 엔드포인트 요청/응답 스키마.
// age_group/regenerate는 기본값을 가지고, character_context는 선택적이다.

export const CharacterContextSchema = z.object({
  name: z.string(),
  class: z.string(),
  level: z.number(),
});

export const TransformRequestSchema = z.object({
  // 상한 500자 — 스펙 §9.1 엣지 케이스 최대 길이를 충분히 커버하고 LLM 비용/DoS를 제한
  habit_text: z.string().min(1).max(500),
  // 소문자·숫자·하이픈·언더스코어만 허용 — 경로 탐색(../), 공백 등 주입 방지
  worldview_id: z.string().regex(/^[a-z0-9_-]+$/, "worldview_id는 소문자, 숫자, 하이픈, 언더스코어만 허용"),
  age_group: z.string().default("7-12"),
  character_context: CharacterContextSchema.optional(),
  regenerate: z.boolean().default(false),
});

export const TransformResponseMetaSchema = z.object({
  model: z.string(),
  latency_ms: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
});

export const TransformResponseSchema = z.object({
  quest: QuestSchema,
  meta: TransformResponseMetaSchema,
});

export type CharacterContext = z.infer<typeof CharacterContextSchema>;
export type TransformRequest = z.infer<typeof TransformRequestSchema>;
export type TransformRequestInput = z.input<typeof TransformRequestSchema>;
export type TransformResponseMeta = z.infer<typeof TransformResponseMetaSchema>;
export type TransformResponse = z.infer<typeof TransformResponseSchema>;

// F-002 Task 7 — /api/quest/generate 엔드포인트 요청/응답 스키마.
// TransformRequest와 동일한 입력 계약을 유지해 QuestRetriever.retrieve(TransformRequest)에
// 그대로 전달할 수 있도록 한다. meta는 경로 분기 결과(path/similarity/latency_ms)를 노출한다.
export const GenerateRequestSchema = TransformRequestSchema;

export const GenerateResponseMetaSchema = z.object({
  // QuestRetriever.route가 결정한 경로 — 스펙 §3.1 경로 분기와 일치.
  path: z.enum(["vector_exact", "vector_modify", "llm_new"]),
  // Vector DB 히트가 없으면 null (QuestRetriever가 null을 반환한다).
  similarity: z.number().nullable(),
  // embed + search + (modify|transform) 전 구간 합산 지연.
  latency_ms: z.number(),
});

export const GenerateResponseSchema = z.object({
  quest: QuestSchema,
  meta: GenerateResponseMetaSchema,
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateRequestInput = z.input<typeof GenerateRequestSchema>;
export type GenerateResponseMeta = z.infer<typeof GenerateResponseMetaSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
