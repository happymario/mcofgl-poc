/**
 * F-004 Task 7 — 통합 파이프라인 E2E 평가 러너 (`eval:integrated`).
 *
 * 역할:
 * - 100건 습관 샘플(sample-50.json × 2 worldview + 5건 부적절 습관)을
 *   IntegratedPipeline.run()에 통과시키고 경로 분포 / p95 지연 / 건당 비용을 집계한다.
 * - G-1(5 경로 각 1건 이상 관측) / G-2(경로별 p95 + 비용 보고서) 증빙을 제공한다.
 *
 * computeIntegratedMetrics는 순수 함수 — 단위 테스트 대상.
 * runIntegratedEval은 실제 인프라에 의존하는 CLI 전용 함수.
 *
 * CLI 인자:
 * - --output=<path>      기본: data/evaluations/integrated-run-<timestamp>.json
 * - --limit=<n>          기본: 100
 * - --fixtures=<path>    기본: data/habits/sample-50.json (× 2 worldview 조합)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "ioredis";
import OpenAI from "openai";
import { z } from "zod";
import { RedisCache } from "../core/cache.js";
import { LightModifier } from "../core/modifier.js";
import { IntegratedPipeline } from "../core/pipeline.js";
import { QuestRetriever } from "../core/retriever.js";
import { FallbackSelector } from "../core/safety/fallback-selector.js";
import { LlmVerifier } from "../core/safety/llm-verifier.js";
import { loadSafetyRules } from "../core/safety/load-safety-rules.js";
import { SafetyFilterPipeline } from "../core/safety/pipeline.js";
import { RuleFilter } from "../core/safety/rule-filter.js";
import { QuestTransformer } from "../core/transformer.js";
import { EmbeddingService } from "../core/vector/embedding.js";
import { VectorStore } from "../core/vector/store.js";

// ── 공개 타입 ────────────────────────────────────────────────────────────────

/** 단일 파이프라인 호출 결과. error가 있으면 집계에서 제외된다. */
export interface IntegratedRunItem {
  id: string;
  habit_text: string;
  worldview_id: string;
  processing_path: string;
  safety_check: string;
  latency_ms: number;
  estimated_cost_usd: number;
  error?: string;
}

export interface IntegratedMetrics {
  /** 경로별 성공 건수 (5개 경로 모두 포함, 0건도 표시). */
  path_distribution: Record<string, number>;
  /** 경로별 p95 지연 (ms). 해당 경로 항목이 없으면 0. */
  p95_by_path: Record<string, number>;
  /** 성공 항목의 estimated_cost_usd 합산. */
  total_cost_usd: number;
  /** total_cost_usd / 전체 항목 수 (에러 포함). */
  avg_cost_per_item: number;
  /** 5개 경로 모두 1건 이상 관측됐으면 true. */
  g1_pass: boolean;
  /** pipeline.run() throw 건수. */
  error_count: number;
}

export interface IntegratedRunResult {
  runId: string;
  completedAt: string;
  items: IntegratedRunItem[];
  summary: IntegratedMetrics;
}

export interface IntegratedRunOptions {
  output: string;
  limit: number;
  fixtures?: string;
}

// ── 순수 계산 로직 ───────────────────────────────────────────────────────────

const ALL_PATHS = [
  "cache",
  "vector_exact",
  "vector_modify",
  "llm_new",
  "fallback",
] as const;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * 0.95;
  const i = Math.floor(index);
  const frac = index - i;
  const lower = sorted[i] as number;
  if (i + 1 < sorted.length) {
    return lower + frac * ((sorted[i + 1] as number) - lower);
  }
  return lower;
}

/**
 * 경로 분포 / p95 지연 / 비용 / G-1 판정을 한 번에 산출한다.
 *
 * - error가 있는 항목은 path_distribution / p95 / cost 집계에서 제외 (error_count에만 포함).
 * - avg_cost_per_item은 에러 포함 전체 항목 수로 나눈다 (운영 실제 비용과 일치).
 */
export function computeIntegratedMetrics(
  items: IntegratedRunItem[],
): IntegratedMetrics {
  const successItems = items.filter((it) => !it.error);

  const path_distribution = Object.fromEntries(ALL_PATHS.map((p) => [p, 0]));
  for (const item of successItems) {
    path_distribution[item.processing_path] =
      (path_distribution[item.processing_path] ?? 0) + 1;
  }

  const p95_by_path: Record<string, number> = {};
  for (const path of ALL_PATHS) {
    const latencies = successItems
      .filter((it) => it.processing_path === path)
      .map((it) => it.latency_ms);
    p95_by_path[path] = p95(latencies);
  }

  const total_cost_usd = successItems.reduce(
    (sum, it) => sum + it.estimated_cost_usd,
    0,
  );
  const avg_cost_per_item =
    items.length > 0 ? total_cost_usd / items.length : 0;

  const g1_pass = ALL_PATHS.every((path) => (path_distribution[path] ?? 0) >= 1);
  const error_count = items.filter((it) => !!it.error).length;

  return {
    path_distribution,
    p95_by_path,
    total_cost_usd,
    avg_cost_per_item,
    g1_pass,
    error_count,
  };
}

// ── CLI 인자 파싱 ────────────────────────────────────────────────────────────

// safety-runner.ts / match-runner.ts와 동일한 경로 탐색 방지 패턴.
function rejectTraversal(inputPath: string, label = "경로"): string {
  const parts = inputPath.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) {
    throw new Error(`${label}에 경로 탐색(..)이 포함됩니다: ${inputPath}`);
  }
  return inputPath;
}

function defaultOutputPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join("data", "evaluations", `integrated-run-${ts}.json`);
}

export function parseIntegratedArgs(argv: string[]): IntegratedRunOptions {
  let output: string | undefined;
  let limit = 100;
  let fixtures: string | undefined;

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq < 0) continue;
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (!value) continue;

    if (key === "output") output = rejectTraversal(value, "출력 경로");
    else if (key === "limit") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (key === "fixtures") {
      fixtures = rejectTraversal(value, "픽스처 경로");
    }
  }

  return { output: output ?? defaultOutputPath(), limit, fixtures };
}

// ── 픽스처 생성 ──────────────────────────────────────────────────────────────

interface FixtureItem {
  id: string;
  habit_text: string;
  worldview_id: string;
}

// eval:integrated는 경로 분포·지연·비용을 측정하는 것이 목적이다.
// unsafe 습관은 LLM 거절을 유발해 15~20초 소비하고 비용을 왜곡하므로 제외한다.
// 안전 필터 검증은 eval:safety가 담당한다.
const BUILTIN_UNSAFE_ITEMS: FixtureItem[] = [];

const HabitFixtureItemSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
});

function buildFixtures(options: IntegratedRunOptions): FixtureItem[] {
  const WORLDVIEWS = ["kingdom_of_light", "starlight_magic_school"];

  const habitPath = options.fixtures ?? join("data", "habits", "sample-50.json");
  const parsed: unknown = JSON.parse(readFileSync(habitPath, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`픽스처 파일이 배열이어야 합니다: ${habitPath}`);
  }
  const habits = parsed.map((item, idx) => {
    const result = HabitFixtureItemSchema.safeParse(item);
    if (!result.success) {
      throw new Error(`픽스처 항목 검증 실패 [${idx}]: ${result.error.message}`);
    }
    return result.data;
  });

  const items: FixtureItem[] = [...BUILTIN_UNSAFE_ITEMS];

  for (const wv of WORLDVIEWS) {
    for (const h of habits) {
      items.push({ id: `${h.id}-${wv}`, habit_text: h.text, worldview_id: wv });
    }
  }

  return items.slice(0, options.limit);
}

// ── 파이프라인 조립 ──────────────────────────────────────────────────────────

interface PipelineBundle {
  pipeline: IntegratedPipeline;
  redis?: Redis;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`필수 환경변수 누락: ${key}`);
  return v;
}

async function buildPipeline(): Promise<PipelineBundle> {
  const anthropic = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const haikuModel =
    process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";
  const embeddingModel = requireEnv("OPENAI_EMBEDDING_MODEL");

  const embedding = new EmbeddingService(openai, embeddingModel);
  const store = new VectorStore(supabase);
  const modifier = new LightModifier(anthropic, haikuModel);
  const transformer = new QuestTransformer(anthropic, haikuModel);

  const ruleFilter = new RuleFilter(loadSafetyRules());
  const llmVerifier = new LlmVerifier(anthropic, haikuModel);
  const fallback = new FallbackSelector(embedding, store);
  const safetyPipeline = new SafetyFilterPipeline(
    ruleFilter,
    llmVerifier,
    fallback,
  );

  const retriever = new QuestRetriever({
    embedding,
    store,
    modifier,
    transformer,
    safetyPipeline,
  });

  // Redis는 옵셔널.
  let redis: Redis | undefined;
  let cache: RedisCache | undefined;
  try {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
    });
    redis.on("error", (err) =>
      console.error("[eval:integrated] Redis 에러:", err.message),
    );
    await redis.connect();
    cache = new RedisCache(redis);
    console.error("[eval:integrated] Redis 연결 성공");
  } catch {
    console.error("[eval:integrated] Redis 미연결 — 캐시 없이 계속");
    if (redis) {
      redis.disconnect();
      redis = undefined;
    }
  }

  const pipeline = new IntegratedPipeline({
    retriever,
    transformer,
    fallback,
    cache,
    safetyPipeline,
  });

  return { pipeline, redis };
}

// ── 콘솔 요약 출력 ───────────────────────────────────────────────────────────

function printSummary(summary: IntegratedMetrics, total: number): void {
  const fmt = (v: number) => v.toFixed(1);
  const fmtCost = (v: number) => `$${v.toFixed(6)}`;

  console.error("\n=== Integrated Pipeline Eval Summary ===");
  console.error(`Total: ${total} items  Errors: ${summary.error_count}`);

  console.error("\n[Path Distribution]");
  for (const path of ALL_PATHS) {
    const count = summary.path_distribution[path] ?? 0;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.error(
      `  ${path.padEnd(14)} ${String(count).padStart(4)} (${pct}%)  p95=${fmt(summary.p95_by_path[path] ?? 0)}ms`,
    );
  }

  console.error("\n[Cost]");
  console.error(`  total:    ${fmtCost(summary.total_cost_usd)}`);
  console.error(`  avg/item: ${fmtCost(summary.avg_cost_per_item)}`);

  console.error(
    `\nG-1 (5경로 관측): ${summary.g1_pass ? "PASS ✓" : "FAIL ✗"}`,
  );
}

// ── 실행 루프 ────────────────────────────────────────────────────────────────

export async function runIntegratedEval(
  options: IntegratedRunOptions,
): Promise<IntegratedRunResult> {
  const runId = `integrated-run-${Date.now()}`;
  const fixtures = buildFixtures(options);
  const total = fixtures.length;

  console.error(
    `[eval:integrated] 시작: limit=${options.limit} items=${total}`,
  );

  const { pipeline, redis } = await buildPipeline();

  const items: IntegratedRunItem[] = [];

  for (let i = 0; i < fixtures.length; i += 1) {
    const fx = fixtures[i] as FixtureItem;
    try {
      const result = await pipeline.run({
        habit_text: fx.habit_text,
        worldview_id: fx.worldview_id,
        age_group: "7-12",
        regenerate: false,
      });
      items.push({
        id: fx.id,
        habit_text: fx.habit_text,
        worldview_id: fx.worldview_id,
        processing_path: result.meta.processing_path,
        safety_check: result.meta.safety_check,
        latency_ms: result.meta.latency_ms,
        estimated_cost_usd: result.meta.estimated_cost_usd,
      });
      console.error(
        `[eval:integrated] ${i + 1}/${total} ${fx.id} path=${result.meta.processing_path} ${result.meta.latency_ms}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[eval:integrated] ${i + 1}/${total} ${fx.id} ✗ ${message}`,
      );
      items.push({
        id: fx.id,
        habit_text: fx.habit_text,
        worldview_id: fx.worldview_id,
        processing_path: "fallback",
        safety_check: "fallback",
        latency_ms: 0,
        estimated_cost_usd: 0,
        error: message,
      });
    }
  }

  if (redis) {
    await redis.quit().catch(() => {});
  }

  const summary = computeIntegratedMetrics(items);

  const result: IntegratedRunResult = {
    runId,
    completedAt: new Date().toISOString(),
    items,
    summary,
  };

  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, JSON.stringify(result, null, 2), "utf-8");

  printSummary(summary, total);
  return result;
}

// ── CLI 진입점 ───────────────────────────────────────────────────────────────

const entryArg = process.argv[1] ?? "";
if (
  entryArg.endsWith("integrated-runner.ts") ||
  entryArg.endsWith("integrated-runner.js")
) {
  (async () => {
    const options = parseIntegratedArgs(process.argv.slice(2));
    try {
      const result = await runIntegratedEval(options);
      console.error(
        `[eval:integrated] done: items=${result.items.length} → ${options.output}`,
      );
    } catch (err) {
      console.error(
        `[eval:integrated] fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  })();
}
