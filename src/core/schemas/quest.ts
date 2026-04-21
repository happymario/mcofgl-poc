import { z } from "zod";

// 스펙 §3.3 — LLM이 반환하는 퀘스트 DTO 스키마.
// category / stat / grade는 enum으로 고정해 LLM 출력의 드리프트를 차단한다.

export const QuestCategorySchema = z.enum([
  "기상/취침",
  "위생",
  "식사",
  "학습",
  "운동/외출",
  "정리정돈",
  "사회성",
  "생활습관",
]);

export const QuestStatSchema = z.enum(["체력", "지혜", "매력", "근성"]);

export const QuestGradeSchema = z.enum(["D", "C", "B", "A", "S"]);

export const MandatorySuitabilitySchema = z.enum(["high", "medium", "low"]);

export const QuestRewardSchema = z.object({
  exp: z.number(),
  coin: z.number(),
  buff: z.string().optional(),
});

export const QuestSchema = z.object({
  quest_name: z.string(),
  description: z.string(),
  category: QuestCategorySchema,
  stat_mapping: z.record(QuestStatSchema, z.number()),
  reward: QuestRewardSchema,
  suggested_grade: QuestGradeSchema,
  mandatory_suitability: MandatorySuitabilitySchema,
  original_habit: z.string(),
  worldview_id: z.string(),
});

export type QuestCategory = z.infer<typeof QuestCategorySchema>;
export type QuestStat = z.infer<typeof QuestStatSchema>;
export type QuestGrade = z.infer<typeof QuestGradeSchema>;
export type MandatorySuitability = z.infer<typeof MandatorySuitabilitySchema>;
export type QuestReward = z.infer<typeof QuestRewardSchema>;
export type Quest = z.infer<typeof QuestSchema>;
