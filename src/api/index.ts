// F-001 Task 7 / F-002 Task 7 — 서버 부트스트랩.
//
// - Anthropic 클라이언트와 모델 식별자를 환경변수에서 주입 → QuestTransformer 조립
// - Supabase/OpenAI 키가 있으면 EmbeddingService + VectorStore + LightModifier + QuestTransformer
//   → QuestRetriever 조립. 키가 없으면 retriever 없이 /transform 만 활성화 (graceful degradation)
// - 이 파일은 top-level await로 side effect를 가지므로 테스트에서 import 금지.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { LightModifier } from "../core/modifier.js";
import { QuestRetriever } from "../core/retriever.js";
import { QuestTransformer } from "../core/transformer.js";
import { EmbeddingService } from "../core/vector/embedding.js";
import { VectorStore } from "../core/vector/store.js";
import { type RetrieverPort, buildServer } from "./server.js";

const anthropic = new Anthropic();
const haikuModel = process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";
const transformer = new QuestTransformer(anthropic, haikuModel);

// Retriever 조립 — 3개 환경변수가 모두 있을 때만 활성화.
// 부분 설정(예: SUPABASE_URL만 존재)은 기동 시점에 silent 실패하지 않고 명시적으로 로그에 기록.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiEmbeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

let retriever: RetrieverPort | undefined;
if (supabaseUrl && supabaseServiceRoleKey && openaiApiKey) {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const embedding = new EmbeddingService(openai, openaiEmbeddingModel);
  const store = new VectorStore(supabase);
  const modifier = new LightModifier(anthropic, haikuModel);
  retriever = new QuestRetriever({ embedding, store, modifier, transformer });
  console.info(
    "[bootstrap] QuestRetriever 활성화 — /api/quest/generate 사용 가능",
  );
} else {
  console.warn(
    "[bootstrap] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/OPENAI_API_KEY 중 일부가 없어 retriever 비활성 — /api/quest/transform 만 사용 가능",
  );
}

const app = buildServer(transformer, retriever);

const rawPort = process.env.PORT ?? "3000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 환경변수가 유효하지 않습니다: ${rawPort}`);
}
await app.listen({ port, host: "0.0.0.0" });
