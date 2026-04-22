// F-001 Task 7 — Fastify HTTP 서버.
// F-002 Task 7 — /api/quest/generate 라우트 추가 (retriever 주입 시).
//
// 스펙 §3.4 HTTP 계약 구현:
// - POST /api/quest/transform (F-001)
//   - Zod로 요청 body 검증 → 실패 시 400
//   - QuestTransformer.transform() 호출
//     - ParseError → 422 (LLM 응답 파싱 실패)
//     - ValidationError → 422 (Quest 스키마 검증 실패)
//     - 기타 예외 → 500 (내부 디테일 노출 금지)
//   - 성공 → 200 + TransformResponse JSON
// - POST /api/quest/generate (F-002, retriever 주입 시에만 등록)
//   - 동일한 검증/에러 매핑 규칙 적용
//   - 성공 → 200 + GenerateResponse JSON { quest, meta: { path, similarity, latency_ms } }
//
// transformer / retriever는 생성자 주입 — 테스트에서 모킹 가능.
// 시그니처는 positional(optional retriever) — 기존 buildServer(transformer) 호출과의 호환성 보장.

import Fastify, { type FastifyInstance } from "fastify";
import type { ZodError } from "zod";
import { ParseError, ValidationError } from "../core/errors.js";
import type { QuestRetriever } from "../core/retriever.js";
import {
  GenerateRequestSchema,
  TransformRequestSchema,
} from "../core/schemas/api.js";
import type { QuestTransformer } from "../core/transformer.js";

// 핸들러 의존성은 각 메서드만 필요 — 테스트 모킹을 단순화한다.
export type TransformerPort = Pick<QuestTransformer, "transform">;
export type RetrieverPort = Pick<QuestRetriever, "retrieve">;

// Zod 에러 메시지를 간결한 단일 문자열로 평탄화 (스택/내부 구조 노출 방지).
function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

// ParseError/ValidationError/기타 예외를 적절한 HTTP 상태코드로 변환.
// 두 라우트(/transform, /generate)에서 동일한 에러 매핑을 재사용한다.
import type { FastifyReply } from "fastify";
function replyWithError(reply: FastifyReply, err: unknown, tag: string): ReturnType<FastifyReply["send"]> {
  if (err instanceof ParseError) {
    return reply.status(422).send({ error: `LLM 응답 파싱 실패: ${(err as Error).message}` });
  }
  if (err instanceof ValidationError) {
    return reply.status(422).send({ error: `Quest 스키마 검증 실패: ${(err as Error).message}` });
  }
  console.error(`[${tag}] unhandled error:`, err);
  return reply.status(500).send({ error: "내부 서버 오류" });
}

export function buildServer(
  transformer: TransformerPort,
  retriever?: RetrieverPort,
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post("/api/quest/transform", async (request, reply) => {
    const parsed = TransformRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: `요청 검증 실패: ${formatZodError(parsed.error)}` });
    }

    try {
      const result = await transformer.transform(parsed.data);
      return reply.status(200).send(result);
    } catch (err) {
      return replyWithError(reply, err, "/api/quest/transform");
    }
  });

  // retriever가 주입된 경우에만 /api/quest/generate 라우트 등록.
  // 주입이 없으면 라우트 자체가 없어 404로 응답됨 (graceful degradation).
  if (retriever) {
    app.post("/api/quest/generate", async (request, reply) => {
      const parsed = GenerateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: `요청 검증 실패: ${formatZodError(parsed.error)}` });
      }

      try {
        const result = await retriever.retrieve(parsed.data);
        return reply.status(200).send(result);
      } catch (err) {
        return replyWithError(reply, err, "/api/quest/generate");
      }
    });
  }

  return app;
}
