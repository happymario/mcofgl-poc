// F-001 Task 8 — LLM 호출 메트릭 수집기.
//
// 스펙 §7.3 — 평가 실행 중 각 호출의 지연/토큰/비용을 기록하고
// 전체 실행 종료 시 요약(summary)을 산출한다.
//
// p50/p95 계산은 선형 보간 방식을 사용한다:
//   index = (n - 1) * percentile
//   i     = floor(index)
//   frac  = index - i
//   value = values[i] + frac * (values[i+1] - values[i])  (i+1 < n)
//         = values[i]                                     (그 외)

export interface CallRecord {
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export interface MetricsSummary {
  count: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  // 호출부가 n=0을 걸러내므로 여기서는 n>=1을 가정한다.
  const index = (n - 1) * p;
  const i = Math.floor(index);
  const frac = index - i;
  const lower = sorted[i] as number;
  if (i + 1 < n) {
    const upper = sorted[i + 1] as number;
    return lower + frac * (upper - lower);
  }
  return lower;
}

export class MetricsCollector {
  private readonly records: CallRecord[] = [];

  recordCall(record: CallRecord): void {
    this.records.push(record);
  }

  summary(): MetricsSummary | null {
    const n = this.records.length;
    if (n === 0) {
      return null;
    }

    let totalLatency = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCostUsd = 0;
    const latencies: number[] = new Array(n);

    for (let i = 0; i < n; i += 1) {
      const r = this.records[i] as CallRecord;
      latencies[i] = r.latencyMs;
      totalLatency += r.latencyMs;
      totalPromptTokens += r.promptTokens;
      totalCompletionTokens += r.completionTokens;
      totalCostUsd += r.costUsd ?? 0;
    }

    latencies.sort((a, b) => a - b);

    return {
      count: n,
      avgLatencyMs: totalLatency / n,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      totalPromptTokens,
      totalCompletionTokens,
      totalCostUsd,
    };
  }
}
