// F-002 Task 3 — EmbeddingService.
//
// 책임:
// - OpenAI `embeddings.create` 호출 (text-embedding-3-small 기본)
// - 입력 사전 검증: trim 후 빈 문자열이면 RangeError (LLM 비용 방어)
// - 응답 벡터 길이가 1536이 아니면 명시적 에러 (차원 불일치 조기 탐지)
// - API 실패 시 cause가 보존된 Error로 재-throw
//
// 의존성 주입:
// - OpenAI 클라이언트는 생성자 주입 (테스트는 vi.mock으로 교체 가능).
// - top-level에서 `new OpenAI()`를 생성하지 않아 환경변수 부재 시에도 모듈 로드가 안전하다.

import type OpenAI from "openai";

// text-embedding-3-small이 반환하는 고정 차원. 스펙 §3.3 `vector(1536)`과 일치.
const EXPECTED_DIMENSIONS = 1536;

export class EmbeddingService {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new RangeError("embed(text): 빈 문자열은 임베딩할 수 없습니다");
    }

    let response: Awaited<ReturnType<OpenAI["embeddings"]["create"]>>;
    try {
      response = await this.client.embeddings.create({
        model: this.model,
        input: trimmed,
      });
    } catch (cause) {
      throw new Error("OpenAI embeddings API 호출 실패", { cause });
    }

    const vector = response.data[0]?.embedding;
    if (!vector) {
      throw new Error("OpenAI embeddings 응답에 임베딩 벡터가 없습니다");
    }
    if (vector.length !== EXPECTED_DIMENSIONS) {
      throw new Error(
        `임베딩 차원 불일치: 기대 ${EXPECTED_DIMENSIONS}, 실제 ${vector.length}`,
      );
    }

    return vector;
  }
}
