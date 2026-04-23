// F-004 Task 6 — 서버 엔트리포인트 전체 배선.
//
// 조립 순서:
//   환경변수 검증
//   → Anthropic / OpenAI / Supabase 클라이언트
//   → EmbeddingService, VectorStore, LightModifier, QuestTransformer
//   → RuleFilter, LlmVerifier, FallbackSelector, SafetyFilterPipeline
//   → QuestRetriever
//   → RedisCache (실패 시 warn + cache=undefined)
//   → IntegratedPipeline
//   → buildServer(transformer, pipeline)
//   → listen(PORT, HOST)
//
// 이 파일은 top-level await + side effect를 가지므로 테스트에서 import 금지.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "ioredis";
import OpenAI from "openai";
import { RedisCache } from "../core/cache.js";
import { IntegratedPipeline } from "../core/pipeline.js";
import { LightModifier } from "../core/modifier.js";
import { QuestRetriever } from "../core/retriever.js";
import { FallbackSelector } from "../core/safety/fallback-selector.js";
import { LlmVerifier } from "../core/safety/llm-verifier.js";
import { loadSafetyRules } from "../core/safety/load-safety-rules.js";
import { SafetyFilterPipeline } from "../core/safety/pipeline.js";
import { RuleFilter } from "../core/safety/rule-filter.js";
import { QuestTransformer } from "../core/transformer.js";
import { EmbeddingService } from "../core/vector/embedding.js";
import { VectorStore } from "../core/vector/store.js";
import { buildServer } from "./server.js";

// ── 환경변수 검증 ────────────────────────────────────────────────────────────

const required = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(`필수 환경변수 누락: ${missing.join(", ")}`);
}

// ── 클라이언트 생성 ──────────────────────────────────────────────────────────

const anthropic = new Anthropic();
const openai = new OpenAI();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// ── 모델 식별자 ──────────────────────────────────────────────────────────────

const haikuModel = process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";
const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL!;

// ── 코어 서비스 조립 ─────────────────────────────────────────────────────────

const embedding = new EmbeddingService(openai, embeddingModel);
const store = new VectorStore(supabase);
const modifier = new LightModifier(anthropic, haikuModel);
const transformer = new QuestTransformer(anthropic, haikuModel);

// ── Safety Filter 조립 ───────────────────────────────────────────────────────

const safetyRules = loadSafetyRules();
const ruleFilter = new RuleFilter(safetyRules);
const llmVerifier = new LlmVerifier(anthropic, haikuModel);
const fallback = new FallbackSelector(embedding, store);
const safetyPipeline = new SafetyFilterPipeline(ruleFilter, llmVerifier, fallback);

// ── QuestRetriever 조립 ──────────────────────────────────────────────────────

const retriever = new QuestRetriever({
  embedding,
  store,
  modifier,
  transformer,
  safetyPipeline,
});

// ── Redis / RedisCache 조립 (실패 시 cache 미주입으로 계속) ──────────────────

let redis: Redis | undefined;
let cache: RedisCache | undefined;

try {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  redis = new Redis(redisUrl, {
    // 연결 실패가 서버 기동을 막지 않도록 재시도를 끄고 즉시 에러로 처리.
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
  });
  // 런타임 에러를 unhandled error 이벤트로 흘려보내지 않는다.
  redis.on("error", (err) => {
    console.warn("[bootstrap] Redis 런타임 에러:", err.message);
  });
  await redis.connect();
  cache = new RedisCache(redis);
  console.info("[bootstrap] Redis 연결 성공");
} catch (cause) {
  console.warn("[bootstrap] Redis 연결 실패 — 캐시 없이 계속:", cause);
  if (redis) {
    redis.disconnect();
    redis = undefined;
  }
  cache = undefined;
}

// ── IntegratedPipeline 조립 ──────────────────────────────────────────────────

const pipeline = new IntegratedPipeline({
  retriever,
  transformer,
  fallback,
  cache,
  safetyPipeline,
});

// ── Fastify 서버 기동 ────────────────────────────────────────────────────────

const app = buildServer(transformer, pipeline);

const rawPort = process.env.PORT ?? "3000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 환경변수가 유효하지 않습니다: ${rawPort}`);
}

await app.listen({ port, host: "0.0.0.0" });
console.info(`[bootstrap] listening on :${port}`);

// ── Graceful Shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[bootstrap] 두 번째 ${signal} — 강제 종료`);
    process.exit(1);
  }
  shuttingDown = true;
  console.info(`[bootstrap] ${signal} 수신 — graceful shutdown 시작`);
  try {
    await app.close();
    if (redis) {
      await redis.quit();
    }
    console.info("[bootstrap] shutdown 완료");
    process.exit(0);
  } catch (cause) {
    console.error("[bootstrap] shutdown 중 에러:", cause);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
