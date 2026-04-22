// F-001 Task 8 — MetricsCollector 계약 테스트.
//
// 검증 책임:
// - 0건: summary()는 null
// - 1건: summary() 정상 반환, p50=p95=유일값
// - N건: 선형 보간 p50/p95 정확도 (index = (n-1) * percentile)
// - totalCostUsd는 costUsd가 undefined인 기록을 0으로 합산
// - 토큰 합계 정확도

import { beforeEach, describe, expect, it } from "vitest";
import {
  type CallRecord,
  MetricsCollector,
} from "../../src/eval/metrics.js";

function makeRecord(partial: Partial<CallRecord> = {}): CallRecord {
  return {
    model: "claude-test",
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 5,
    ...partial,
  };
}

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("기록이 0건이면 summary()는 null을 반환한다", () => {
    expect(collector.summary()).toBeNull();
  });

  it("1건 기록: p50 = p95 = 유일한 지연값", () => {
    collector.recordCall(
      makeRecord({
        latencyMs: 250,
        promptTokens: 30,
        completionTokens: 10,
        costUsd: 0.002,
      }),
    );

    const summary = collector.summary();
    expect(summary).not.toBeNull();
    if (summary === null) throw new Error("unreachable");

    expect(summary.count).toBe(1);
    expect(summary.avgLatencyMs).toBe(250);
    expect(summary.p50LatencyMs).toBe(250);
    expect(summary.p95LatencyMs).toBe(250);
    expect(summary.totalPromptTokens).toBe(30);
    expect(summary.totalCompletionTokens).toBe(10);
    expect(summary.totalCostUsd).toBeCloseTo(0.002, 6);
  });

  it("N=20건: p50=10.5, p95=19.05 (선형 보간 공식)", () => {
    // latencyMs = 1..20; sorted 그대로.
    // p50: index = 19 * 0.5 = 9.5 → 0.5*values[9] + 0.5*values[10] = 0.5*10 + 0.5*11 = 10.5
    // p95: index = 19 * 0.95 = 18.05 → 0.95*values[18] + 0.05*values[19] = 0.95*19 + 0.05*20 = 19.05
    for (let i = 1; i <= 20; i += 1) {
      collector.recordCall(
        makeRecord({
          latencyMs: i,
          promptTokens: 2,
          completionTokens: 3,
          costUsd: 0.001,
        }),
      );
    }

    const summary = collector.summary();
    expect(summary).not.toBeNull();
    if (summary === null) throw new Error("unreachable");

    expect(summary.count).toBe(20);
    expect(summary.avgLatencyMs).toBeCloseTo(10.5, 6);
    expect(summary.p50LatencyMs).toBeCloseTo(10.5, 6);
    expect(summary.p95LatencyMs).toBeCloseTo(19.05, 6);
    expect(summary.totalPromptTokens).toBe(40);
    expect(summary.totalCompletionTokens).toBe(60);
    expect(summary.totalCostUsd).toBeCloseTo(0.02, 6);
  });

  it("기록 순서와 무관하게 정렬 후 백분위를 계산한다", () => {
    // 순서 섞어서 넣어도 동일 결과 (1..20)
    const shuffled = [7, 3, 20, 1, 15, 8, 4, 11, 2, 18, 5, 14, 10, 19, 6, 13, 9, 17, 12, 16];
    for (const v of shuffled) {
      collector.recordCall(makeRecord({ latencyMs: v }));
    }

    const summary = collector.summary();
    if (summary === null) throw new Error("unreachable");
    expect(summary.p50LatencyMs).toBeCloseTo(10.5, 6);
    expect(summary.p95LatencyMs).toBeCloseTo(19.05, 6);
  });

  it("costUsd가 undefined인 기록은 0으로 합산한다", () => {
    collector.recordCall(makeRecord({ latencyMs: 100 })); // costUsd 없음
    collector.recordCall(makeRecord({ latencyMs: 200, costUsd: 0.005 }));
    collector.recordCall(makeRecord({ latencyMs: 300 })); // costUsd 없음

    const summary = collector.summary();
    if (summary === null) throw new Error("unreachable");
    expect(summary.count).toBe(3);
    expect(summary.totalCostUsd).toBeCloseTo(0.005, 6);
  });

  it("N=2건: p50=1.5, p95=1.95 (선형 보간)", () => {
    // 경계 케이스: 두 점 사이 보간
    // p50: index = 1 * 0.5 = 0.5 → 0.5*1 + 0.5*2 = 1.5
    // p95: index = 1 * 0.95 = 0.95 → 0.05*1 + 0.95*2 = 1.95
    collector.recordCall(makeRecord({ latencyMs: 1 }));
    collector.recordCall(makeRecord({ latencyMs: 2 }));

    const summary = collector.summary();
    if (summary === null) throw new Error("unreachable");
    expect(summary.p50LatencyMs).toBeCloseTo(1.5, 6);
    expect(summary.p95LatencyMs).toBeCloseTo(1.95, 6);
  });
});
