// F-004 — 모델 단가 상수 모듈 테스트.
//
// 검증 책임:
// - 등록된 모델(claude-haiku-4-5-20251001)에 대해 입·출력 토큰 기반 비용 계산 정확성
// - 토큰이 0이면 비용도 0
// - 등록되지 않은 모델이면 비용 0 반환 (fallback)
// - MODEL_PRICING 맵에 타겟 두 모델이 포함되어 있고 단가가 스펙과 일치

import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  MODEL_PRICING,
  type ModelPricing,
} from "../src/config.js";

describe("MODEL_PRICING", () => {
  it("claude-haiku-4-5-20251001 단가가 정의되어 있다", () => {
    const pricing: ModelPricing | undefined =
      MODEL_PRICING["claude-haiku-4-5-20251001"];
    expect(pricing).toBeDefined();
    expect(pricing?.input_per_1m_usd).toBe(0.8);
    expect(pricing?.output_per_1m_usd).toBe(4.0);
  });

  it("claude-sonnet-4-5 단가가 정의되어 있다", () => {
    const pricing: ModelPricing | undefined = MODEL_PRICING["claude-sonnet-4-5"];
    expect(pricing).toBeDefined();
    expect(pricing?.input_per_1m_usd).toBe(3.0);
    expect(pricing?.output_per_1m_usd).toBe(15.0);
  });
});

describe("estimateCostUsd", () => {
  it("알려진 모델(haiku)에서 실제 토큰 수에 대해 정확한 비용을 반환한다", () => {
    // 입력 1,000,000 토큰 × $0.80/1M = $0.80
    // 출력 500,000 토큰 × $4.00/1M = $2.00
    // 합계 $2.80
    const cost = estimateCostUsd(
      "claude-haiku-4-5-20251001",
      1_000_000,
      500_000,
    );
    expect(cost).toBeCloseTo(2.8, 10);
  });

  it("알려진 모델(sonnet)에서 소량 토큰에 대해 정확한 비용을 반환한다", () => {
    // 입력 2,000 × $3.00/1M = $0.006
    // 출력 1,000 × $15.00/1M = $0.015
    // 합계 $0.021
    const cost = estimateCostUsd("claude-sonnet-4-5", 2_000, 1_000);
    expect(cost).toBeCloseTo(0.021, 10);
  });

  it("토큰 수가 모두 0이면 비용 0을 반환한다", () => {
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });

  it("미등록 모델이면 비용 0을 반환한다", () => {
    expect(estimateCostUsd("unknown-model-xyz", 100_000, 50_000)).toBe(0);
  });

  it("미등록 모델 + 토큰 0 조합에서도 비용 0을 반환한다", () => {
    expect(estimateCostUsd("unknown-model-xyz", 0, 0)).toBe(0);
  });
});
