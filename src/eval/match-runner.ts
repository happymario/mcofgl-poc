// F-002 Task 9 — 매칭 평가 러너.
//
// 역할:
// - 유사 습관 100건(data/habits/similar-100.json)을 QuestRetriever에 통과시켜
//   경로별 분포, 평균 지연, 임계값별 트레이드오프, 의도 보존율을 리포트한다.
// - G-1 (matchRate_0_7 ≥ 0.60), G-2 (avgLatencyMs < 200 @ vector_exact),
//   G-3 (intentPreservationRate ≥ 0.85) 측정 근거를 생성.
//
// 임계값 해석 (--thresholds=0.7,0.8,0.9):
// - 플랜은 "3 threshold 블록"을 요구하고 retriever는 exact > modify 를 강제한다.
// - 단일 CSV 값은 각각 `exact` 임계값으로 해석한다.
// - modify는 기본 설정(exact=0.9, modify=0.7, 간격=0.2)을 존중해
//   `modify = exact - 0.2` 규칙으로 도출한다.
// - 예: --thresholds=0.7,0.8,0.9 → (0.9,0.7), (0.8,0.6), (0.7,0.5)
// - 0.2 이하 값은 modify ≤ 0 이 되어 retriever invariant를 깨므로 parseArgs에서 거부한다.
//
// 경로별 재실행 모델:
// - 플랜의 "각 threshold 조합마다 QuestRetriever 조립 후 100건 순차 처리" 지시대로,
//   threshold 블록마다 retriever를 새로 만들어 전 입력을 다시 통과시킨다.
// - 주의: llm_new 경로에서 VectorStore.save가 일어나면 후속 블록에서 저장된 항목이
//   히트로 돌아와 경로 분포를 왜곡할 수 있다. 이는 실측 실행의 알려진 한계이며,
//   고정밀 비교가 필요한 경우 블록 간 DB 초기화를 수동으로 수행해야 한다.
//   (테스트는 retriever 자체를 DI로 교체하므로 이 한계의 영향을 받지 않는다.)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { z } from "zod";
import { LightModifier } from "../core/modifier.js";
import { QuestRetriever } from "../core/retriever.js";
import type { RetrieveResult, RoutingPath } from "../core/retriever.js";
import { QuestCategorySchema } from "../core/schemas/quest.js";
import { QuestTransformer } from "../core/transformer.js";
import { EmbeddingService } from "../core/vector/embedding.js";
import { VectorStore } from "../core/vector/store.js";

const DEFAULT_WORLDVIEWS = ["kingdom_of_light", "starlight_magic_school"] as const;
const DEFAULT_INPUT_PATH = "data/habits/similar-100.json";
const DEFAULT_THRESHOLDS = [0.7, 0.8, 0.9];
// modify = exact - MODIFY_DELTA; retriever의 기본값 쌍 (0.9, 0.7) 간격과 일치.
const MODIFY_DELTA = 0.2;
const DEFAULT_AGE_GROUP = "7-12";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SimilarHabit {
  id: string;
  text: string;
  expectedHabitCategory: string;
  originalId: string | null;
}

export interface MatchRunOptions {
  /** 입력 유사 습관 JSON 파일 경로 */
  input: string;
  /** 실행 대상 세계관 ID 목록 */
  worldviews: string[];
  /** 스윕할 exact 임계값 목록 (modify는 exact - 0.2) */
  thresholds: number[];
  /** 결과 JSON 저장 경로. 빈 문자열이면 stdout으로 출력. */
  output: string;
}

export interface ParsedArgs extends MatchRunOptions {}

export interface MatchItem {
  habitId: string;
  habitText: string;
  worldviewId: string;
  /** 실패 시 null — 경로 분포/매치율 산출에서 제외된다 */
  path: RoutingPath | null;
  similarity: number | null;
  /** 실패 시 null — 지연 지표 산출에서 제외된다 */
  latencyMs: number | null;
  /** vector_exact 경로에서만 category 일치 여부, 그 외 경로는 null */
  intentPreserved: boolean | null;
  /** 실패 시에만 존재 */
  error?: string;
}

export interface ThresholdSummary {
  /** 성공한 items 수 — matchRate, 지연 지표의 분모로 쓰인다 */
  total: number;
  /** 실패한 items 수 — 측정 지표 왜곡 방지를 위해 별도 추적 */
  failed: number;
  vectorExact: number;
  vectorModify: number;
  llmNew: number;
  /** 전 경로 평균 지연 (참고용) */
  avgLatencyMs: number;
  /** vector_exact 경로만의 평균 지연 — G-2 측정 기준. vectorExact=0이면 null */
  avgLatencyExactMs: number | null;
  p95LatencyMs: number;
  /**
   * 이 블록의 라우팅 임계값으로 재활용된 비율: (vectorExact + vectorModify) / total.
   * G-1(0.7 threshold 기준)을 읽으려면 exact=0.9 블록의 raw similarity >= 0.7 히트율이 아닌
   * modify=0.7 블록(exact=0.9)의 이 값을 참조한다. total=0이면 0.
   */
  vectorHitRate: number;
  /** vector_exact 중 intentPreserved 비율. vectorExact=0이면 null */
  intentPreservationRate: number | null;
}

export interface ThresholdBlock {
  exact: number;
  modify: number;
  items: MatchItem[];
  summary: ThresholdSummary;
}

export interface MatchRunResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  thresholds: ThresholdBlock[];
}

export interface MatchRunDeps {
  /** 테스트/고급 사용 — 주입 시 env 없이 이 retriever를 threshold 블록마다 재사용한다. */
  retriever?: QuestRetriever;
}

// -----------------------------------------------------------------------------
// CLI parsing
// -----------------------------------------------------------------------------

function rejectTraversal(inputPath: string, label = "경로"): string {
  const parts = inputPath.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) {
    throw new Error(`${label}에 경로 탐색(..)이 포함됩니다: ${inputPath}`);
  }
  return inputPath;
}

function parseKeyValue(arg: string): [string, string] | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg.slice(2), ""];
  return [arg.slice(2, eq), arg.slice(eq + 1)];
}

function parseThresholds(value: string): number[] {
  if (value.length === 0) return [...DEFAULT_THRESHOLDS];
  const parts = value.split(",").map((s) => s.trim());
  const result: number[] = [];
  for (const p of parts) {
    if (p.length === 0) continue;
    const n = Number(p);
    if (!Number.isFinite(n)) {
      throw new Error(`--thresholds 값이 숫자가 아닙니다: "${p}"`);
    }
    // modify = exact - 0.2 이 retriever invariant(>0)를 만족하려면 exact > 0.2.
    if (n <= MODIFY_DELTA || n > 1) {
      throw new Error(
        `--thresholds 값은 (${MODIFY_DELTA}, 1] 범위여야 합니다 (exact > modify 보장). 입력: ${p}`,
      );
    }
    result.push(n);
  }
  if (result.length === 0) {
    throw new Error(`--thresholds 에 유효한 숫자가 없습니다: "${value}"`);
  }
  return result;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let input = DEFAULT_INPUT_PATH;
  let worldviews: string[] = [...DEFAULT_WORLDVIEWS];
  let thresholds = [...DEFAULT_THRESHOLDS];
  let output = "";

  for (const arg of argv) {
    const kv = parseKeyValue(arg);
    if (kv === null) continue;
    const [key, value] = kv;

    if (key === "input") {
      if (value.length > 0) input = rejectTraversal(value, "입력 경로");
    } else if (key === "worldview") {
      if (value === "" || value === "all") {
        worldviews = [...DEFAULT_WORLDVIEWS];
      } else {
        worldviews = [value];
      }
    } else if (key === "thresholds") {
      thresholds = parseThresholds(value);
    } else if (key === "output") {
      if (value.length > 0) output = rejectTraversal(value, "출력 경로");
    }
  }

  return { input, worldviews, thresholds, output };
}

// -----------------------------------------------------------------------------
// Input loading
// -----------------------------------------------------------------------------

function loadHabits(path: string): SimilarHabit[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}는 배열이어야 합니다`);
  }
  // Zod로 구조·enum 검증 — expectedHabitCategory 오타가 G-3 silent 오판을 방지한다.
  const SimilarHabitSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    expectedHabitCategory: QuestCategorySchema,
    originalId: z.string().nullable().optional(),
  });
  const result = z.array(SimilarHabitSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error(`${path} 형식 오류: ${result.error.message}`);
  }
  return result.data as SimilarHabit[];
}

// -----------------------------------------------------------------------------
// Retriever factory (CLI 경로에서만 사용)
// -----------------------------------------------------------------------------

interface EnvConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey: string;
  openaiEmbeddingModel: string;
  anthropicApiKey: string;
  haikuModel: string;
}

function requireEnv(): EnvConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiEmbeddingModel = process.env.OPENAI_EMBEDDING_MODEL;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const haikuModel = process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!openaiEmbeddingModel) missing.push("OPENAI_EMBEDDING_MODEL");
  if (!anthropicApiKey) missing.push("ANTHROPIC_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수가 설정되지 않았습니다: ${missing.join(", ")}. .env 파일을 확인하세요.`,
    );
  }

  return {
    supabaseUrl: supabaseUrl as string,
    supabaseServiceRoleKey: supabaseServiceRoleKey as string,
    openaiApiKey: openaiApiKey as string,
    openaiEmbeddingModel: openaiEmbeddingModel as string,
    anthropicApiKey: anthropicApiKey as string,
    haikuModel,
  };
}

function buildRetriever(env: EnvConfig, exact: number, modify: number): QuestRetriever {
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: env.openaiApiKey });
  const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

  return new QuestRetriever({
    embedding: new EmbeddingService(openai, env.openaiEmbeddingModel),
    store: new VectorStore(supabase),
    modifier: new LightModifier(anthropic, env.haikuModel),
    transformer: new QuestTransformer(anthropic, env.haikuModel),
    thresholds: { exact, modify },
  });
}

// -----------------------------------------------------------------------------
// Percentile (선형 보간 — metrics.ts와 동일 공식)
// -----------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
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

function summarize(items: MatchItem[]): ThresholdSummary {
  // 실패한 item(path=null)은 분포·매치율·지연 지표 어디에도 포함하지 않는다 —
  // G-1/G-2/G-3 측정이 실패 건수만큼 왜곡되는 것을 막기 위함.
  let failed = 0;
  let vectorExact = 0;
  let vectorModify = 0;
  let llmNew = 0;
  let totalLatency = 0;
  let exactLatency = 0;
  let preservedCount = 0;
  const latencies: number[] = [];

  for (const item of items) {
    if (item.path === null || item.latencyMs === null) {
      failed += 1;
      continue;
    }
    latencies.push(item.latencyMs);
    totalLatency += item.latencyMs;
    if (item.path === "vector_exact") {
      vectorExact += 1;
      exactLatency += item.latencyMs;
      if (item.intentPreserved === true) preservedCount += 1;
    } else if (item.path === "vector_modify") {
      vectorModify += 1;
    } else {
      llmNew += 1;
    }
  }

  latencies.sort((a, b) => a - b);

  const total = vectorExact + vectorModify + llmNew;
  const avgLatencyMs = total > 0 ? totalLatency / total : 0;
  // G-2 기준: vector_exact 경로 단독 평균 — 플랜 §Completion Criteria 참조
  const avgLatencyExactMs = vectorExact > 0 ? exactLatency / vectorExact : null;
  const p95LatencyMs = percentile(latencies, 0.95);
  const vectorHitRate = total > 0 ? (vectorExact + vectorModify) / total : 0;
  const intentPreservationRate =
    vectorExact === 0 ? null : preservedCount / vectorExact;

  return {
    total,
    failed,
    vectorExact,
    vectorModify,
    llmNew,
    avgLatencyMs,
    avgLatencyExactMs,
    p95LatencyMs,
    vectorHitRate,
    intentPreservationRate,
  };
}

// -----------------------------------------------------------------------------
// Core execution
// -----------------------------------------------------------------------------

async function processBlock(
  habits: SimilarHabit[],
  worldviews: string[],
  retriever: QuestRetriever,
  exact: number,
  totalJobs: number,
  completedSoFar: number,
): Promise<{ items: MatchItem[]; done: number }> {
  const items: MatchItem[] = [];
  let done = completedSoFar;

  for (const wvId of worldviews) {
    for (const habit of habits) {
      done += 1;
      try {
        const result: RetrieveResult = await retriever.retrieve({
          habit_text: habit.text,
          worldview_id: wvId,
          age_group: DEFAULT_AGE_GROUP,
          regenerate: false,
        });

        const intentPreserved =
          result.meta.path === "vector_exact"
            ? result.quest.category === habit.expectedHabitCategory
            : null;

        items.push({
          habitId: habit.id,
          habitText: habit.text,
          worldviewId: wvId,
          path: result.meta.path,
          similarity: result.meta.similarity,
          latencyMs: result.meta.latency_ms,
          intentPreserved,
        });

        console.error(
          `[match] ${done}/${totalJobs} ${habit.id}×${wvId} (exact=${exact}) ` +
            `${result.meta.path} sim=${result.meta.similarity ?? "null"} ${result.meta.latency_ms}ms`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[match] ${done}/${totalJobs} ${habit.id}×${wvId} (exact=${exact}) ✗ ${message}`,
        );
        // 실패 item은 path/latencyMs=null, error=msg로 기록한다.
        // summarize()는 이들을 failed 카운트에만 포함하고 분포/매치율/지연에서 제외해
        // 측정 지표가 실패 건수만큼 왜곡되는 것을 막는다.
        items.push({
          habitId: habit.id,
          habitText: habit.text,
          worldviewId: wvId,
          path: null,
          similarity: null,
          latencyMs: null,
          intentPreserved: null,
          error: message,
        });
      }
    }
  }

  return { items, done };
}

function printBlockSummary(block: ThresholdBlock, worldviewLabel: string): void {
  const s = block.summary;
  // G-1: modify=0.7 블록(exact=0.9)의 vectorHitRate가 기준 — 다른 블록은 참고용
  const matchPass = s.vectorHitRate >= 0.6 ? "PASS" : "FAIL";
  // G-2: vector_exact 경로만의 평균 지연 기준
  const latencyExactDisplay = s.avgLatencyExactMs === null ? "N/A" : `${s.avgLatencyExactMs.toFixed(0)}ms`;
  const latencyPass = s.avgLatencyExactMs === null ? "N/A" : s.avgLatencyExactMs < 200 ? "PASS" : "FAIL";
  const intentDisplay = s.intentPreservationRate === null ? "N/A" : s.intentPreservationRate.toFixed(2);
  const intentPass =
    s.intentPreservationRate === null
      ? "N/A"
      : s.intentPreservationRate >= 0.85
        ? "PASS"
        : "FAIL";

  console.error(
    `\nThreshold exact=${block.exact} modify=${block.modify} [worldview=${worldviewLabel}]`,
  );
  const failedSuffix = s.failed > 0 ? `, failed: ${s.failed}` : "";
  console.error(
    `  vector_exact: ${s.vectorExact}, vector_modify: ${s.vectorModify}, llm_new: ${s.llmNew}${failedSuffix}`,
  );
  console.error(
    `  vectorHitRate: ${s.vectorHitRate.toFixed(2)}  [G-1 목표 ≥0.60 @ modify=0.7 블록: ${matchPass}]`,
  );
  console.error(
    `  avgLatencyMs (all): ${s.avgLatencyMs.toFixed(0)}ms`,
  );
  console.error(
    `  avgLatencyExactMs: ${latencyExactDisplay}  [G-2 목표 <200ms: ${latencyPass}]`,
  );
  console.error(
    `  p95LatencyMs: ${s.p95LatencyMs.toFixed(0)}ms`,
  );
  console.error(
    `  intentPreservationRate: ${intentDisplay}  [G-3 목표 ≥0.85: ${intentPass}]`,
  );
}

/**
 * 매칭 평가 실행.
 *
 * deps.retriever가 주입되면 모든 threshold 블록이 동일 인스턴스를 공유한다 — 테스트 전용.
 * 주입이 없으면 threshold 쌍마다 새 retriever를 조립한다.
 */
export async function runMatchEval(
  options: MatchRunOptions,
  deps: MatchRunDeps = {},
): Promise<MatchRunResult> {
  const runId = `match-${Date.now()}`;
  const startedAt = new Date().toISOString();

  const habits = loadHabits(options.input);

  // env는 실제 retriever 조립이 필요한 경우에만 검증. 테스트는 deps.retriever 주입으로 우회.
  let env: EnvConfig | null = null;
  if (!deps.retriever) {
    env = requireEnv();
  }

  const totalJobs =
    options.thresholds.length * options.worldviews.length * habits.length;
  console.error(
    `[match] 시작: input=${options.input} worldviews=[${options.worldviews.join(", ")}] ` +
      `thresholds=[${options.thresholds.join(", ")}] total=${totalJobs}건`,
  );

  const blocks: ThresholdBlock[] = [];
  let completedSoFar = 0;

  for (const exact of options.thresholds) {
    const modify = Number((exact - MODIFY_DELTA).toFixed(6));
    const retriever =
      deps.retriever ?? (env ? buildRetriever(env, exact, modify) : null);
    if (!retriever) {
      // 타입상 도달 불가 (deps.retriever 없을 땐 env가 세팅됨).
      throw new Error("retriever를 조립할 수 없습니다");
    }

    const { items, done } = await processBlock(
      habits,
      options.worldviews,
      retriever,
      exact,
      totalJobs,
      completedSoFar,
    );
    completedSoFar = done;

    const summary = summarize(items);
    const block: ThresholdBlock = { exact, modify, items, summary };
    blocks.push(block);

    const wvLabel =
      options.worldviews.length === DEFAULT_WORLDVIEWS.length &&
      DEFAULT_WORLDVIEWS.every((id) => options.worldviews.includes(id))
        ? "all"
        : options.worldviews.join(",");
    printBlockSummary(block, wvLabel);
  }

  const completedAt = new Date().toISOString();
  const result: MatchRunResult = {
    runId,
    startedAt,
    completedAt,
    thresholds: blocks,
  };

  if (options.output.length > 0) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, JSON.stringify(result, null, 2), "utf-8");
    console.error(`[match] done: → ${options.output}`);
  } else {
    // stdout 출력 — 파이프라인 용.
    process.stdout.write(JSON.stringify(result, null, 2));
  }

  return result;
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------

const entryArg = process.argv[1] ?? "";
if (entryArg.endsWith("match-runner.ts") || entryArg.endsWith("match-runner.js")) {
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      await runMatchEval(options);
    } catch (err) {
      console.error(`[match] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  })();
}
