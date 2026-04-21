// F-002 Task 3 — EmbeddingService 계약 테스트.
//
// - OpenAI SDK를 vi.mock으로 완전 교체해 네트워크 호출을 차단한다.
// - text → 1536차원 임베딩 배열 반환 계약을 검증한다.
// - 입력 검증(빈 문자열 사전 거부)과 에러 래핑(cause 보존) 정책을 명세한다.
// - 생성자 주입된 model 인자가 그대로 SDK에 전달됨을 spy로 확인한다.

import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "../../../src/core/vector/embedding.js";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn(() => ({
    embeddings: { create: mockCreate },
  })),
}));

// OpenAI CreateEmbeddingResponse 형태를 그대로 재현한 응답 빌더.
function buildEmbeddingResponse(vector: number[]) {
  return {
    data: [{ embedding: vector, index: 0, object: "embedding" as const }],
    model: "text-embedding-3-small",
    object: "list" as const,
    usage: { prompt_tokens: 3, total_tokens: 3 },
  };
}

function newService(model = "text-embedding-3-small"): EmbeddingService {
  const client = new OpenAI({ apiKey: "test" });
  return new EmbeddingService(client, model);
}

describe("EmbeddingService", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("유효 입력에 대해 길이 1536의 number 배열을 반환한다", async () => {
    const fixture = Array.from({ length: 1536 }, (_, i) => i / 1536);
    mockCreate.mockResolvedValueOnce(buildEmbeddingResponse(fixture));

    const result = await newService().embed("아침 기상");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1536);
    expect(result.every((n) => typeof n === "number")).toBe(true);
    expect(result[0]).toBe(fixture[0]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("빈 문자열(혹은 공백 전용)을 입력하면 RangeError를 던지고 SDK는 호출하지 않는다", async () => {
    const service = newService();

    await expect(service.embed("")).rejects.toBeInstanceOf(RangeError);
    await expect(service.embed("   ")).rejects.toBeInstanceOf(RangeError);

    // LLM 비용 방어: 사전 거부 시 SDK 호출이 발생해서는 안 된다.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("OpenAI API 에러를 던지면 cause가 보존된 Error로 재-throw 한다", async () => {
    const apiError = new Error("OpenAI API is down");
    mockCreate.mockRejectedValueOnce(apiError);

    const service = newService();
    // 원본 에러는 래핑되어 다른 Error 인스턴스로 재-throw 되지만,
    // 근본 원인(cause)은 apiError 그대로 보존되어야 한다.
    const caught = await service.embed("아침 기상").then(
      () => null,
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(apiError);
    expect((caught as Error).cause).toBe(apiError);
  });

  it("주입된 model과 입력 text가 SDK embeddings.create에 그대로 전달된다", async () => {
    const fixture = Array.from({ length: 1536 }, () => 0);
    mockCreate.mockResolvedValue(buildEmbeddingResponse(fixture));

    await newService("text-embedding-3-custom").embed("아침 기상");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toEqual({
      model: "text-embedding-3-custom",
      input: "아침 기상",
    });
  });

  it("응답 벡터 길이가 1536이 아니면 차원 불일치 에러를 던진다", async () => {
    const wrong = Array.from({ length: 1535 }, () => 0);
    mockCreate.mockResolvedValueOnce(buildEmbeddingResponse(wrong));

    await expect(newService().embed("아침 기상")).rejects.toThrow(/1536/);
  });

  it("응답 data에 임베딩이 없으면 명시적 에러를 던진다", async () => {
    mockCreate.mockResolvedValueOnce({ data: [], model: "text-embedding-3-small", object: "list", usage: { prompt_tokens: 1, total_tokens: 1 } });

    await expect(newService().embed("아침 기상")).rejects.toThrow(/임베딩 벡터가 없습니다/);
  });
});
