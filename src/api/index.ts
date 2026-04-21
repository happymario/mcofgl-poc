// F-001 Task 7 — 서버 부트스트랩.
//
// - Anthropic 클라이언트와 모델 식별자를 환경변수에서 주입
// - QuestTransformer 조립 → buildServer → listen
// - 이 파일은 top-level await로 side effect를 가지므로 테스트에서 import 금지.

import Anthropic from "@anthropic-ai/sdk";
import { QuestTransformer } from "../core/transformer.js";
import { buildServer } from "./server.js";

const client = new Anthropic();
const model = process.env.CLAUDE_MODEL_HAIKU ?? "claude-haiku-4-5-20251001";
const transformer = new QuestTransformer(client, model);
const app = buildServer(transformer);

const rawPort = process.env.PORT ?? "3000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT 환경변수가 유효하지 않습니다: ${rawPort}`);
}
await app.listen({ port, host: "0.0.0.0" });
