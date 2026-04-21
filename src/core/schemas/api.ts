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
  habit_text: z.string().min(1),
  worldview_id: z.string(),
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
