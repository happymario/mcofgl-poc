// 스펙 §F-003 Task 4 — LlmVerifier 계약 테스트.
//
// LlmVerifier는 Claude Haiku에 퀘스트(연령대 포함)를 전달해
// safe / borderline / unsafe 3종 verdict를 JSON으로 받는다.
//
// 핵심 규칙:
// 1) messages.create 1회 호출 (재시도 없음).
// 2) 응답 텍스트는 stripCodeFence로 언랩 후 JSON.parse.
// 3) 파싱 실패 또는 enum 외 verdict → fail-closed (verdict="unsafe") + console.error.
// 4) latency_ms는 performance.now() 차분 (>=0).
// 5) Anthropic 클라이언트는 `vi.mock`이 아닌 직접 fake 주입 (transformer와 의도적으로 다른 패턴).

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmVerifier } from "../../../src/core/safety/llm-verifier.js";
import type { Quest } from "../../../src/core/schemas/quest.js";

const mockCreate = vi.fn();
const fakeClient = {
  messages: { create: mockCreate },
} as unknown as Anthropic;

function buildAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 20 },
  };
}

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    quest_name: "아침 의식",
    description: "아침 7시에 일어나 창문을 연다",
    category: "기상/취침",
    stat_mapping: { 체력: 2 },
    reward: { exp: 30, coin: 10 },
    suggested_grade: "D",
    mandatory_suitability: "high",
    original_habit: "아침 7시에 일어나기",
    worldview_id: "kingdom_of_light",
    ...overrides,
  };
}

describe("LlmVerifier.verify", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCreate.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("1) safe 응답을 파싱해 verdict=safe를 반환한다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse('{"verdict":"safe"}'),
    );

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(result.verdict).toBe("safe");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("2) unsafe 응답의 reason을 그대로 반영한다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse('{"verdict":"unsafe","reason":"폭력 묘사"}'),
    );

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(result.verdict).toBe("unsafe");
    expect(result.reason).toBe("폭력 묘사");
  });

  it("3) borderline 응답을 파싱해 verdict=borderline을 반환한다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse('{"verdict":"borderline"}'),
    );

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(result.verdict).toBe("borderline");
  });

  it("4) JSON 파싱 실패 시 fail-closed(verdict=unsafe) + console.error 로그를 남긴다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse("이건 JSON이 아닙니다"),
    );

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(result.verdict).toBe("unsafe");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("5) 코드펜스로 감싼 응답도 정상 파싱한다", async () => {
    const wrapped = '```json\n{"verdict":"safe"}\n```';
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse(wrapped));

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(result.verdict).toBe("safe");
  });

  it("6) latency_ms는 0 이상의 숫자다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse('{"verdict":"safe"}'),
    );

    const verifier = new LlmVerifier(fakeClient);
    const result = await verifier.verify(makeQuest(), "7-12");

    expect(typeof result.latency_ms).toBe("number");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
