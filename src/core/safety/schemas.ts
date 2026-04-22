// 스펙 §F-003 — Safety Filter 룰/픽스처 Zod 스키마.
//
// - SafetyCategorySchema: 카테고리별 키워드/정규식/액션/대체어 매핑.
// - SafetyRulesSchema: 전체 룰 파일 최상위 구조 (categories + allowlist).
// - SafetyFixtureItemSchema: 평가용 픽스처 한 줄의 기대 결과.
//
// 실제 RegExp 컴파일은 load-safety-rules.ts에서 수행한다 (스키마는 문자열만 검증).

import { z } from "zod";

const BlockAndFallbackCategorySchema = z.object({
  keywords: z.array(z.string()),
  patterns: z.array(z.string()).optional(),
  action: z.literal("block_and_fallback"),
});

const ReplaceCategorySchema = z.object({
  keywords: z.array(z.string()),
  patterns: z.array(z.string()).optional(),
  action: z.literal("replace"),
  replacements: z.record(z.string(), z.string()),
});

export const SafetyCategorySchema = z.discriminatedUnion("action", [
  BlockAndFallbackCategorySchema,
  ReplaceCategorySchema,
]);

export const SafetyRulesSchema = z.object({
  categories: z.record(z.string(), SafetyCategorySchema),
  allowlist: z.array(z.string()).default([]),
});

export const SafetyFixtureItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  expected_block: z.boolean(),
  category: z.string().optional(),
  rationale: z.string().optional(),
});

export type SafetyCategory = z.infer<typeof SafetyCategorySchema>;
export type SafetyRules = z.infer<typeof SafetyRulesSchema>;
export type SafetyFixtureItem = z.infer<typeof SafetyFixtureItemSchema>;
