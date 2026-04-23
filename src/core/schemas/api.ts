import { z } from "zod";
import { QuestSchema } from "./quest.js";

// 스펙 §3.1 — /transform 엔드포인트 요청/응답 스키마.
// age_group/regenerate는 기본값을 가지고, character_context는 선택적이다.

// character_context 문자열 필드는 시스템 프롬프트에 직접 삽입되므로
// 길이 상한과 제어 문자 금지를 적용해 프롬프트 인젝션을 제한한다.
const PROMPT_STRING_MAX = 100;
// ASCII 제어 문자(코드 포인트 0~31, 127)를 거부 — 프롬프트 인젝션 표면 축소
const hasControlChar = (s: string) =>
  [...s].some((c) => { const n = c.codePointAt(0) ?? 0; return n < 32 || n === 127; });
const promptSafeString = (max = PROMPT_STRING_MAX) =>
  z.string().min(1).max(max).refine(
    (s) => !hasControlChar(s),
    "제어 문자는 허용되지 않습니다",
  );

export const CharacterContextSchema = z.object({
  name: promptSafeString(),
  class: promptSafeString(),
  level: z.number().int().min(1).max(999),
});

export const TransformRequestSchema = z.object({
  // 상한 500자 — 스펙 §9.1 엣지 케이스 최대 길이를 충분히 커버하고 LLM 비용/DoS를 제한
  habit_text: z.string().min(1).max(500),
  // 소문자·숫자·하이픈·언더스코어만 허용 — 경로 탐색(../), 공백 등 주입 방지
  worldview_id: z.string().regex(/^[a-z0-9_-]+$/, "worldview_id는 소문자, 숫자, 하이픈, 언더스코어만 허용"),
  // "숫자-숫자" 형식으로 제한 (예: "7-12") — 프롬프트 인젝션 방지
  age_group: z.string().regex(/^\d{1,2}-\d{1,2}$/, "age_group은 '숫자-숫자' 형식이어야 합니다").max(10).default("7-12"),
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

// F-003 Task 1 — Safety Filter 결과 스키마.
// stage: rule(1차 키워드 기반) | llm(2차 LLM 판정)
// verdict: safe(통과) | unsafe(차단) | borderline(경계) | replaced(대체 생성)
// latency_ms는 필터 전체 지연, rule_latency_ms/llm_latency_ms는 단계별 세부 지연(optional).
export const FilterResultSchema = z.object({
  stage: z.enum(["rule", "llm"]),
  verdict: z.enum(["safe", "unsafe", "borderline", "replaced"]),
  blocked: z.boolean(),
  latency_ms: z.number(),
  rule_latency_ms: z.number().optional(),
  llm_latency_ms: z.number().optional(),
});

// F-004 Task 5 — PRD 확정 응답 메타 스키마.
//
// 기존 GenerateResponseMeta(path/similarity/filter_result)를 IntegratedPipeline의
// 새 메타 스키마로 전면 교체한다. 변경 사유:
// - "path"는 retriever 내부 경로(3종)였으나, 통합 파이프라인은 cache/fallback을 포함한
//   5종 처리 경로(processing_path)를 노출해야 한다.
// - safety_check / model_used / tokens / cost는 운영 모니터링 및 비용 집계용 메타.
//
// 매핑 규칙(IntegratedPipeline에서 채움):
// - cache HIT             : path=cache, safety=passed, model_used=null, tokens=0
// - vector_exact          : safety=passed (filter 미적용), model_used=null, tokens=0
// - vector_modify         : safety=mapFilter(filter_result), model_used/tokens=meta.llm_usage
// - llm_new + safe        : safety=mapFilter(filter_result), model_used/tokens=meta.llm_usage
// - llm_new + blocked     : path=fallback, safety=fallback, model_used=null, tokens=0
// - retriever throw → llm : path=llm_new, safety=mapFilter, model_used/tokens=transformer.meta
// - 모든 fallback 경로     : tokens=0, model_used=null, cost=0
export const GenerateResponseMetaSchema = z.object({
  processing_path: z.enum([
    "cache",
    "vector_exact",
    "vector_modify",
    "llm_new",
    "fallback",
  ]),
  similarity_score: z.number().nullable(),
  safety_check: z.enum(["passed", "replaced", "fallback"]),
  latency_ms: z.number(),
  model_used: z.string().nullable(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  estimated_cost_usd: z.number(),
});

export const GenerateResponseSchema = z.object({
  quest: QuestSchema,
  meta: GenerateResponseMetaSchema,
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateRequestInput = z.input<typeof GenerateRequestSchema>;
export type GenerateResponseMeta = z.infer<typeof GenerateResponseMetaSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// F-003 Task 1 — Safety Filter 관련 타입.
export type FilterResult = z.infer<typeof FilterResultSchema>;
export type FilterStage = FilterResult["stage"];
export type FilterVerdict = FilterResult["verdict"];
