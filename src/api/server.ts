// F-001 Task 7 — Fastify HTTP 서버.
//
// 스펙 §3.4 HTTP 계약 구현:
// - POST /api/quest/transform
// - Zod로 요청 body 검증 → 실패 시 400
// - QuestTransformer.transform() 호출
//   - ParseError → 422 (LLM 응답 파싱 실패)
//   - ValidationError → 422 (Quest 스키마 검증 실패)
//   - 기타 예외 → 500 (내부 디테일 노출 금지)
// - 성공 → 200 + TransformResponse JSON
//
// transformer는 생성자 주입 — 테스트에서 모킹 가능.

import Fastify, { type FastifyInstance } from "fastify";
import type { ZodError } from "zod";
import { ParseError, ValidationError } from "../core/errors.js";
import { TransformRequestSchema } from "../core/schemas/api.js";
import type { QuestTransformer } from "../core/transformer.js";

// 핸들러 의존성은 transform 메서드만 필요 — 테스트 모킹을 단순화한다.
export type TransformerPort = Pick<QuestTransformer, "transform">;

// Zod 에러 메시지를 간결한 단일 문자열로 평탄화 (스택/내부 구조 노출 방지).
function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export function buildServer(transformer: TransformerPort): FastifyInstance {
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
      if (err instanceof ParseError) {
        return reply
          .status(422)
          .send({ error: `LLM 응답 파싱 실패: ${err.message}` });
      }
      if (err instanceof ValidationError) {
        return reply
          .status(422)
          .send({ error: `Quest 스키마 검증 실패: ${err.message}` });
      }
      // 내부 원인은 서버 측에만 기록 — 클라이언트에는 일반 메시지만 노출
      console.error("[/api/quest/transform] unhandled error:", err);
      return reply.status(500).send({ error: "내부 서버 오류" });
    }
  });

  return app;
}
