// F-004 Task 7 — computeIntegratedMetrics 순수 함수 단위 테스트.
//
// 대상: 경로 분포 / p95 지연 / 비용 / G-1(5경로 관측) 판정.
//
// runIntegratedEval은 실제 LLM/Vector/Redis 인프라에 의존하므로 이 파일에서 테스트하지 않는다.
// 파이프라인 계약은 tests/core/pipeline.test.ts가 담당한다.

import { describe, expect, it } from "vitest";
import {
  computeIntegratedMetrics,
  parseIntegratedArgs,
  type IntegratedRunItem,
} from "../../src/eval/integrated-runner.js";

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function makeItem(
  partial: Partial<IntegratedRunItem> &
    Pick<IntegratedRunItem, "id" | "processing_path">,
): IntegratedRunItem {
  return {
    habit_text: "기본 습관",
    worldview_id: "kingdom_of_light",
    safety_check: "passed",
    latency_ms: 100,
    estimated_cost_usd: 0.001,
    ...partial,
  };
}

function allPathItems(): IntegratedRunItem[] {
  return [
    makeItem({ id: "1", processing_path: "cache", estimated_cost_usd: 0, latency_ms: 5 }),
    makeItem({ id: "2", processing_path: "vector_exact", estimated_cost_usd: 0, latency_ms: 50 }),
    makeItem({ id: "3", processing_path: "vector_modify", estimated_cost_usd: 0.001, latency_ms: 800 }),
    makeItem({ id: "4", processing_path: "llm_new", estimated_cost_usd: 0.002, latency_ms: 1500 }),
    makeItem({ id: "5", processing_path: "fallback", estimated_cost_usd: 0, latency_ms: 10 }),
  ];
}

// ── parseIntegratedArgs 테스트 ───────────────────────────────────────────────

describe("parseIntegratedArgs", () => {
  it("기본값: limit=100, fixtures=undefined, output에 타임스탬프 포함", () => {
    const opts = parseIntegratedArgs([]);
    expect(opts.limit).toBe(100);
    expect(opts.fixtures).toBeUndefined();
    expect(opts.output).toMatch(/integrated-run/);
  });

  it("--limit=10 → limit=10", () => {
    const opts = parseIntegratedArgs(["--limit=10"]);
    expect(opts.limit).toBe(10);
  });

  it("--limit=abc → 기본값 100 유지 (무효 값)", () => {
    const opts = parseIntegratedArgs(["--limit=abc"]);
    expect(opts.limit).toBe(100);
  });

  it("--limit=-5 → 기본값 100 유지 (음수)", () => {
    const opts = parseIntegratedArgs(["--limit=-5"]);
    expect(opts.limit).toBe(100);
  });

  it("--output=out.json → output 반영", () => {
    const opts = parseIntegratedArgs(["--output=out.json"]);
    expect(opts.output).toBe("out.json");
  });

  it("--output=../etc/passwd → rejectTraversal throw", () => {
    expect(() => parseIntegratedArgs(["--output=../etc/passwd"])).toThrow(
      "경로 탐색",
    );
  });

  it("--fixtures=../secret.json → rejectTraversal throw", () => {
    expect(() =>
      parseIntegratedArgs(["--fixtures=../secret.json"]),
    ).toThrow("경로 탐색");
  });

  it("알 수 없는 플래그는 무시", () => {
    const opts = parseIntegratedArgs(["--unknown=foo", "--limit=5"]);
    expect(opts.limit).toBe(5);
  });
});

// ── computeIntegratedMetrics 테스트 ──────────────────────────────────────────

describe("computeIntegratedMetrics", () => {
  it("5 경로 각 1건 이상 → G-1 pass, path_distribution 정확", () => {
    const metrics = computeIntegratedMetrics(allPathItems());

    expect(metrics.g1_pass).toBe(true);
    expect(metrics.path_distribution.cache).toBe(1);
    expect(metrics.path_distribution.vector_exact).toBe(1);
    expect(metrics.path_distribution.vector_modify).toBe(1);
    expect(metrics.path_distribution.llm_new).toBe(1);
    expect(metrics.path_distribution.fallback).toBe(1);
  });

  it("fallback 경로 누락 → G-1 fail", () => {
    const items = allPathItems().filter((it) => it.processing_path !== "fallback");
    const metrics = computeIntegratedMetrics(items);

    expect(metrics.g1_pass).toBe(false);
    expect(metrics.path_distribution.fallback).toBe(0);
  });

  it("cache 경로 누락 → G-1 fail", () => {
    const items = allPathItems().filter((it) => it.processing_path !== "cache");
    const metrics = computeIntegratedMetrics(items);

    expect(metrics.g1_pass).toBe(false);
    expect(metrics.path_distribution.cache).toBe(0);
  });

  it("비용 집계 정확성 — total / avg", () => {
    const items: IntegratedRunItem[] = [
      makeItem({ id: "a", processing_path: "llm_new", estimated_cost_usd: 0.001 }),
      makeItem({ id: "b", processing_path: "llm_new", estimated_cost_usd: 0.003 }),
      makeItem({ id: "c", processing_path: "cache", estimated_cost_usd: 0 }),
    ];
    const metrics = computeIntegratedMetrics(items);

    expect(metrics.total_cost_usd).toBeCloseTo(0.004, 6);
    // avg = total / 전체 항목(에러 포함) 수 = 0.004 / 3
    expect(metrics.avg_cost_per_item).toBeCloseTo(0.004 / 3, 6);
  });

  it("p95 latency — path별 정확성", () => {
    // llm_new: latency 100, 200, ..., 2000 (20건)
    const items: IntegratedRunItem[] = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `i${i}`, processing_path: "llm_new", latency_ms: (i + 1) * 100, estimated_cost_usd: 0 }),
    );
    const metrics = computeIntegratedMetrics(items);

    // p95 of [100,200,...,2000]: index = 19*0.95 = 18.05
    // sorted[18]=1900, sorted[19]=2000 → 1900 + 0.05*(2000-1900) = 1905
    expect(metrics.p95_by_path.llm_new).toBeCloseTo(1905, 0);
    // 다른 경로는 항목 없음 → p95=0
    expect(metrics.p95_by_path.cache).toBe(0);
    expect(metrics.p95_by_path.vector_exact).toBe(0);
  });

  it("에러 항목은 path_distribution / cost 집계에서 제외, error_count에 포함", () => {
    const items: IntegratedRunItem[] = [
      makeItem({ id: "ok", processing_path: "llm_new", estimated_cost_usd: 0.002 }),
      { ...makeItem({ id: "err", processing_path: "llm_new", estimated_cost_usd: 0 }), error: "API 오류" },
    ];
    const metrics = computeIntegratedMetrics(items);

    expect(metrics.error_count).toBe(1);
    expect(metrics.path_distribution.llm_new).toBe(1); // 에러 항목 제외
    expect(metrics.total_cost_usd).toBeCloseTo(0.002, 6);
    // avg = total / 전체(에러 포함) 2건
    expect(metrics.avg_cost_per_item).toBeCloseTo(0.001, 6);
  });

  it("빈 배열 → 에러 없이 g1_pass=false, 모든 값 0", () => {
    const metrics = computeIntegratedMetrics([]);

    expect(metrics.g1_pass).toBe(false);
    expect(metrics.total_cost_usd).toBe(0);
    expect(metrics.avg_cost_per_item).toBe(0);
    expect(metrics.error_count).toBe(0);
    for (const key of Object.keys(metrics.path_distribution)) {
      expect(metrics.path_distribution[key]).toBe(0);
    }
  });

  it("단일 경로 다수 항목 → path_distribution 합산 정확", () => {
    const items: IntegratedRunItem[] = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `v${i}`, processing_path: "vector_exact", estimated_cost_usd: 0 }),
    );
    const metrics = computeIntegratedMetrics(items);

    expect(metrics.path_distribution.vector_exact).toBe(10);
    expect(metrics.path_distribution.llm_new).toBe(0);
    expect(metrics.g1_pass).toBe(false); // 4개 경로 미관측
  });
});
