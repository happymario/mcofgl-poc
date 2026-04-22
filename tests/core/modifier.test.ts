// F-002 Task 5 — LightModifier 계약 테스트.
//
// - Anthropic SDK를 vi.mock으로 교체 (네트워크 호출 금지).
// - 유사도 0.7~0.9 구간에서 기존 퀘스트(baseQuest)를 새 habit_text 의도에
//   맞게 경량 수정하는 LightModifier의 입출력 계약을 명세한다.
// - original_habit / worldview_id는 요청값으로 강제 주입되어야 한다.
// - 시스템 프롬프트에 baseQuest.quest_name 과 새 habitText 가 모두 포함되어야 한다.

import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParseError, ValidationError } from "../../src/core/errors.js";
import { LightModifier } from "../../src/core/modifier.js";
import type { Quest } from "../../src/core/schemas/quest.js";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

const BASE_QUEST: Quest = {
  quest_name: "빛의 서약 실행",
  description: "아침에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
};

const MODIFIED_QUEST_FIXTURE: Quest = {
  quest_name: "빛의 서약 - 이른 기상편",
  description: "새벽 6시 30분에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 2 },
  reward: { exp: 35, coin: 12, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  // 아래 두 필드는 LLM이 잘못된 값을 반환해도 요청값으로 덮어써야 한다.
  original_habit: "LLM이 돌려준 잘못된 habit 값",
  worldview_id: "wrong_worldview",
};

const BASE_PARAMS = {
  habitText: "새벽 6시 30분에 일어나기",
  worldviewId: "kingdom_of_light",
  ageGroup: "7-12",
  baseQuest: BASE_QUEST,
} as const;

function buildAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 100 },
  };
}

function newModifier(): LightModifier {
  const client = new Anthropic({ apiKey: "test" });
  return new LightModifier(client, "claude-test-model", 0.3);
}

describe("LightModifier", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("유효 응답(habitText + baseQuest)을 Quest로 파싱해 반환한다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(MODIFIED_QUEST_FIXTURE)),
    );

    const result = await newModifier().modify({ ...BASE_PARAMS });

    expect(result.quest_name).toBe(MODIFIED_QUEST_FIXTURE.quest_name);
    expect(result.description).toBe(MODIFIED_QUEST_FIXTURE.description);
    expect(result.category).toBe(MODIFIED_QUEST_FIXTURE.category);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("original_habit은 LLM 응답값과 무관하게 요청 habitText로 강제 주입된다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(MODIFIED_QUEST_FIXTURE)),
    );

    const result = await newModifier().modify({ ...BASE_PARAMS });

    // fixture의 original_habit은 "LLM이 돌려준 잘못된 habit 값" 이지만,
    // 요청값(habitText)으로 덮어써야 한다.
    expect(MODIFIED_QUEST_FIXTURE.original_habit).not.toBe(BASE_PARAMS.habitText);
    expect(result.original_habit).toBe(BASE_PARAMS.habitText);
  });

  it("worldview_id는 LLM 응답값과 무관하게 요청 worldviewId로 강제 주입된다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(MODIFIED_QUEST_FIXTURE)),
    );

    const result = await newModifier().modify({ ...BASE_PARAMS });

    expect(MODIFIED_QUEST_FIXTURE.worldview_id).not.toBe(BASE_PARAMS.worldviewId);
    expect(result.worldview_id).toBe(BASE_PARAMS.worldviewId);
  });

  it("JSON 파싱에 실패하면 ParseError를 throw한다 (재시도 없음)", async () => {
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse("this is not json at all"));

    await expect(newModifier().modify({ ...BASE_PARAMS })).rejects.toBeInstanceOf(ParseError);
    // LightModifier는 단일 시도 정책 — 재시도 루프 없음.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("시스템 프롬프트에 baseQuest.quest_name과 새 habitText가 모두 포함된다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(MODIFIED_QUEST_FIXTURE)),
    );

    await newModifier().modify({ ...BASE_PARAMS });

    const call = mockCreate.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(typeof call.system).toBe("string");
    expect(call.system).toContain(BASE_QUEST.quest_name);
    expect(call.system).toContain(BASE_PARAMS.habitText);
  });

  it("JSON은 파싱되지만 스키마 위반이면 ValidationError를 throw한다 (재시도 없음)", async () => {
    const invalid = JSON.stringify({ quest_name: "이름만 있음" });
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse(invalid));

    await expect(newModifier().modify({ ...BASE_PARAMS })).rejects.toBeInstanceOf(ValidationError);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("코드펜스로 래핑된 응답을 언랩해 파싱한다", async () => {
    const wrapped = "```json\n" + JSON.stringify(MODIFIED_QUEST_FIXTURE) + "\n```";
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse(wrapped));

    const result = await newModifier().modify({ ...BASE_PARAMS });
    expect(result.quest_name).toBe(MODIFIED_QUEST_FIXTURE.quest_name);
  });

  it("baseTemperature가 [0, 1] 범위를 벗어나면 RangeError를 throw한다", () => {
    const client = new Anthropic({ apiKey: "test" });
    expect(() => new LightModifier(client, "model", 1.5)).toThrow(RangeError);
    expect(() => new LightModifier(client, "model", -0.1)).toThrow(RangeError);
  });
});
