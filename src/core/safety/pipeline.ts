// 스펙 §F-003 Task 6 — SafetyFilterPipeline: 룰 + LLM + 폴백을 체인으로 조립.
//
// 처리 흐름:
// 1) RuleFilter.check(quest)
//    - block_and_fallback → 즉시 FallbackSelector 호출 (LlmVerifier 스킵: 비용 절감)
//    - replaced → replacedQuest 즉시 반환 (LlmVerifier 스킵: 룰 치환만으로 안전 보장)
//    - pass → 원본 quest를 LlmVerifier로 2차 검증
// 2) LlmVerifier.verify(quest, ageGroup) — pass 경로에서만 호출
//    - safe        → verdict="safe", blocked=false, 원본 quest 반환
//    - unsafe      → FallbackSelector + verdict="unsafe" + blocked=true
//    - borderline  → FallbackSelector + verdict="borderline" + blocked=true
//                    (borderline은 모니터링용 console.warn 로그 추가)
//
// latency 계측:
// - filter_result.latency_ms: apply() 전체 wall-time (performance.now 차분)
// - filter_result.rule_latency_ms: RuleFilter.check 결과의 latency_ms passthrough
// - filter_result.llm_latency_ms: LlmVerifier.verify 결과의 latency_ms passthrough
//                                 (LLM 미호출 경로에서는 undefined)

import type { FilterResult } from "../schemas/api.js";
import type { Quest } from "../schemas/quest.js";
import type { FallbackSelector } from "./fallback-selector.js";
import type { LlmVerifier } from "./llm-verifier.js";
import type { RuleFilter } from "./rule-filter.js";

export interface SafetyFilterPipelineParams {
  quest: Quest;
  habitText: string;
  worldviewId: string;
  ageGroup: string;
}

export interface SafetyFilterPipelineResult {
  quest: Quest;
  filter_result: FilterResult;
}

export class SafetyFilterPipeline {
  constructor(
    private readonly ruleFilter: RuleFilter,
    private readonly llmVerifier: LlmVerifier,
    private readonly fallback: FallbackSelector,
  ) {}

  async apply(
    params: SafetyFilterPipelineParams,
  ): Promise<SafetyFilterPipelineResult> {
    const { quest, habitText, worldviewId, ageGroup } = params;
    const start = performance.now();

    const ruleResult = this.ruleFilter.check(quest);

    // Branch A: RuleFilter가 즉시 차단 → LlmVerifier를 건너뛰고 폴백으로 교체.
    if (ruleResult.verdict === "block_and_fallback") {
      const fallbackQuest = await this.fallback.select({
        habitText,
        worldviewId,
        ageGroup,
      });
      // F-001 계약: original_habit/worldview_id는 항상 현재 요청값으로 강제 주입.
      // 폴백 퀘스트의 저장된 필드와 현재 사용자 요청이 혼동되지 않도록 보장한다.
      return {
        quest: { ...fallbackQuest, original_habit: habitText, worldview_id: worldviewId },
        filter_result: {
          stage: "rule",
          verdict: "unsafe",
          blocked: true,
          latency_ms: performance.now() - start,
          rule_latency_ms: ruleResult.latency_ms,
        },
      };
    }

    // Branch B: 룰이 안전 치환에 성공 → LlmVerifier를 건너뛰고 치환된 quest를 즉시 반환.
    // 룰의 replace 카테고리는 사전 검증된 안전 매핑을 사용하므로 추가 LLM 검증이 불필요하다.
    // RuleFilter 계약: verdict="replaced"이면 replacedQuest는 반드시 non-null.
    // 가드 조건이 false이면(replacedQuest 미존재) Branch C로 흘러 LlmVerifier를 거친다(침묵 안전).
    if (ruleResult.verdict === "replaced" && ruleResult.replacedQuest) {
      // F-001 계약: original_habit / worldview_id는 항상 현재 요청값으로 강제 주입한다.
      // RuleFilter의 replacedQuest는 원본 quest에서 합성되므로 실질적으로 동일하나,
      // Block_and_fallback / unsafe 분기와의 방어적 일관성을 위해 명시적으로 덮어쓴다.
      return {
        quest: { ...ruleResult.replacedQuest, original_habit: habitText, worldview_id: worldviewId },
        filter_result: {
          stage: "rule",
          verdict: "replaced",
          blocked: false,
          latency_ms: performance.now() - start,
          rule_latency_ms: ruleResult.latency_ms,
        },
      };
    }

    // Branch C: pass → 원본 quest를 LlmVerifier로 2차 검증.
    const llmResult = await this.llmVerifier.verify(quest, ageGroup);

    if (llmResult.verdict === "safe") {
      return {
        quest,
        filter_result: {
          stage: "llm",
          verdict: "safe",
          blocked: false,
          latency_ms: performance.now() - start,
          rule_latency_ms: ruleResult.latency_ms,
          llm_latency_ms: llmResult.latency_ms,
        },
      };
    }

    // LLM이 unsafe/borderline 판정 → 폴백으로 교체.
    // borderline은 안전 가능성이 있으나 보수적으로 차단하고, 운영 모니터링을 위해 warn 로그를 남긴다.
    if (llmResult.verdict === "borderline") {
      console.warn(
        "[SafetyFilterPipeline] LlmVerifier borderline 판정 → 폴백 적용",
        { reason: llmResult.reason, quest_name: quest.quest_name },
      );
    }

    const fallbackQuest = await this.fallback.select({
      habitText,
      worldviewId,
      ageGroup,
    });

    // F-001 계약: original_habit/worldview_id는 항상 현재 요청값으로 강제 주입.
    return {
      quest: { ...fallbackQuest, original_habit: habitText, worldview_id: worldviewId },
      filter_result: {
        stage: "llm",
        verdict: llmResult.verdict,
        blocked: true,
        latency_ms: performance.now() - start,
        rule_latency_ms: ruleResult.latency_ms,
        llm_latency_ms: llmResult.latency_ms,
      },
    };
  }
}
