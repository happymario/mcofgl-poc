// F-004 — 모델 단가 상수 및 비용 추정 유틸.
//
// 역할:
// - LLM 호출 비용을 기록/집계하는 계층(예: MetricsCollector)이 참조하는
//   공식 단가표와 계산 함수를 제공한다.
// - 단가는 Anthropic 공개 요금 기준(2026-04 시점)을 수기 입력한다.
//   정확도가 필요한 빌링 레이어가 아닌 관측·대시보드용 근사치다.
//
// 확장 정책:
// - 새 모델을 추가할 때는 MODEL_PRICING에 항목만 추가하면 된다.
// - 미등록 모델은 estimateCostUsd가 0을 반환하므로 호출 측이 크래시하지 않는다.
//   누락된 모델을 탐지하려면 호출 지점에서 별도의 로그/경고를 남긴다.

export interface ModelPricing {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    input_per_1m_usd: 0.8,
    output_per_1m_usd: 4.0,
  },
  "claude-sonnet-4-5": {
    input_per_1m_usd: 3.0,
    output_per_1m_usd: 15.0,
  },
};

/**
 * 프롬프트·완성 토큰 수와 모델 ID로 USD 단위 비용을 추정한다.
 *
 * 미등록 모델에 대해서는 0을 반환한다(조용한 fallback).
 *
 * @param model 모델 식별자 (MODEL_PRICING의 키와 일치해야 함)
 * @param promptTokens 입력(프롬프트) 토큰 수
 * @param completionTokens 출력(완성) 토큰 수
 * @returns 예상 비용(USD). 미등록 모델이면 0.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    return 0;
  }
  const inputCost = (promptTokens / 1_000_000) * pricing.input_per_1m_usd;
  const outputCost =
    (completionTokens / 1_000_000) * pricing.output_per_1m_usd;
  return inputCost + outputCost;
}
