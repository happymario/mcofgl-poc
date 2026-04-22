// 스펙 §F-003 Task 6 — SafetyFilterPipeline: 룰 + LLM + 폴백을 체인으로 조립.
//
// 처리 흐름:
// 1) RuleFilter.check(quest)
//    - block_and_fallback → 즉시 FallbackSelector 호출 (LlmVerifier 스킵: 비용 절감)
//    - replaced → replacedQuest를 LlmVerifier로 2차 검증
//    - pass → 원본 quest를 LlmVerifier로 2차 검증
// 2) LlmVerifier.verify(quest, ageGroup)
//    - safe + (rule=replaced) → verdict="replaced", blocked=false, 치환된 quest 반환
//    - safe + (rule=pass)      → verdict="safe", blocked=false, 원본 quest 반환
//    - unsafe                   → FallbackSelector + verdict="unsafe" + blocked=true
//    - borderline               → FallbackSelector + verdict="borderline" + blocked=true
//                                 (borderline은 모니터링용 console.warn 로그 추가)
//
// latency 계측:
// - filter_result.latency_ms: apply() 전체 wall-time (performance.now 차분)
// - filter_result.rule_latency_ms: RuleFilter.check 결과의 latency_ms passthrough
// - filter_result.llm_latency_ms: LlmVerifier.verify 결과의 latency_ms passthrough
//                                 (LLM 미호출 경로에서는 undefined)

import { type FilterResult } from "../schemas/api.js";
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
      return {
        quest: fallbackQuest,
        filter_result: {
          stage: "rule",
          verdict: "unsafe",
          blocked: true,
          latency_ms: performance.now() - start,
          rule_latency_ms: ruleResult.latency_ms,
        },
      };
    }

    // Branch B/C: replaced는 replacedQuest로, pass는 원본으로 LlmVerifier 진입.
    const candidateQuest: Quest =
      ruleResult.verdict === "replaced" && ruleResult.replacedQuest
        ? ruleResult.replacedQuest
        : quest;

    const llmResult = await this.llmVerifier.verify(candidateQuest, ageGroup);

    if (llmResult.verdict === "safe") {
      // 룰에서 치환이 일어났으면 stage="rule" + verdict="replaced"로 보고.
      // 치환 없음(pass)이면 stage="llm" + verdict="safe".
      if (ruleResult.verdict === "replaced") {
        return {
          quest: candidateQuest,
          filter_result: {
            stage: "rule",
            verdict: "replaced",
            blocked: false,
            latency_ms: performance.now() - start,
            rule_latency_ms: ruleResult.latency_ms,
            llm_latency_ms: llmResult.latency_ms,
          },
        };
      }
      return {
        quest: candidateQuest,
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
        { reason: llmResult.reason, quest_name: candidateQuest.quest_name },
      );
    }

    const fallbackQuest = await this.fallback.select({
      habitText,
      worldviewId,
      ageGroup,
    });

    return {
      quest: fallbackQuest,
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
