import { z } from "zod";
import { QuestSchema } from "./quest.js";

// 스펙 §3.2 — 세계관 Bible. 프롬프트 템플릿이 참조하는 정적 구성 자료.
// few_shots는 QuestSchema를 재사용해 예시 퀘스트의 구조를 강제한다.

export const WorldviewToneSchema = z.object({
  keywords: z.array(z.string()),
  forbidden: z.array(z.string()),
  examples: z.array(z.string()),
});

export const WorldviewNpcSchema = z.object({
  name: z.string(),
  role: z.string(),
  personality: z.string(),
  speech_style: z.string(),
});

export const WorldviewFewShotSchema = z.object({
  habit: z.string(),
  quest: QuestSchema,
});

export const WorldviewBibleSchema = z.object({
  id: z.string(),
  background: z.string(),
  tone: WorldviewToneSchema,
  // 빈 문자열/공백 키는 프롬프트 치환 로직에서 모든 문자에 매칭될 수 있어 거부
  vocabulary: z.record(z.string().trim().min(1), z.string()),
  npcs: z.array(WorldviewNpcSchema),
  few_shots: z.array(WorldviewFewShotSchema),
});

export type WorldviewTone = z.infer<typeof WorldviewToneSchema>;
export type WorldviewNpc = z.infer<typeof WorldviewNpcSchema>;
export type WorldviewFewShot = z.infer<typeof WorldviewFewShotSchema>;
export type WorldviewBible = z.infer<typeof WorldviewBibleSchema>;
