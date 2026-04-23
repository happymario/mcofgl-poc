// F-001 Task 7 / F-002 Task 7 — 서버 부트스트랩.
// F-004 Task 5 — `buildServer` 시그니처가 `(transformer, pipeline?)` 로 교체됨에 따라
//   retriever 배선을 제거. Task 6에서 Redis/SafetyPipeline/FallbackSelector/QuestRetriever를
//   조립해 IntegratedPipeline을 생성하고 buildServer(transformer, pipeline)로 기동한다.
//
// - Anthropic 클라이언트와 모델 식별자를 환경변수에서 주입 → QuestTransformer 조립
// - 현재(Task 5) 시점에는 pipeline 미주입 → /api/quest/transform 만 활성화된다.
// - 이 파일은 top-level await로 side effect를 가지므로 테스트에서 import 금지.

import Anthropic from "@anthropic-ai/sdk";
import { QuestTransformer } from "../core/transformer.js";
import { buildServer } from "./server.js";

const anthropic = new Anthropic();
const haikuModel = process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";
const transformer = new QuestTransformer(anthropic, haikuModel);

console.warn(
  "[bootstrap] Task 6 IntegratedPipeline 배선 전 — /api/quest/transform 만 사용 가능",
);

const app = buildServer(transformer);

const rawPort = process.env.PORT ?? "3000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 환경변수가 유효하지 않습니다: ${rawPort}`);
}
await app.listen({ port, host: "0.0.0.0" });
