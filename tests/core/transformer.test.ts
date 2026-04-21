// F-001 Task 6 — QuestTransformer 계약 테스트.
//
// - Anthropic SDK와 loadBible 모두 vi.mock으로 모킹 (네트워크/파일시스템 호출 금지).
// - TransformRequest → messages.create → 파싱 → Zod 검증 → TransformResponse
//   전체 파이프라인을 계약으로 검증한다.
// - 재시도(temperature 하향) / regenerate 다양성(nonce 주입) / 에러 분류 정책을 명세한다.

import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParseError, ValidationError } from "../../src/core/errors.js";
import { QuestTransformer } from "../../src/core/transformer.js";
import type { Quest } from "../../src/core/schemas/quest.js";
import type { TransformRequest } from "../../src/core/schemas/api.js";
import type { WorldviewBible } from "../../src/core/schemas/worldview.js";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

// loadBible의 파일시스템 의존을 차단한다.
// transformer 테스트의 관심사는 바이블 내용이 아니라 조립된 시스템 프롬프트가
// Anthropic API에 전달되는 과정이다.
const STUB_BIBLE: WorldviewBible = {
  id: "kingdom_of_light",
  background: "테스트 왕국 배경",
  tone: { keywords: ["영웅적"], forbidden: ["기숙사"], examples: ["용사여 나아가라"] },
  vocabulary: { 집: "길드 기지" },
  npcs: [{ name: "레오나르트", role: "길드 마스터", personality: "엄격", speech_style: "반말" }],
  few_shots: [],
};

vi.mock("../../src/core/prompt/load-bible.js", () => ({
  loadBible: vi.fn(() => STUB_BIBLE),
  clearBibleCache: vi.fn(),
}));

const VALID_QUEST_FIXTURE: Quest = {
  quest_name: "빛의 서약 실행",
  description: "아침에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "placeholder",
  worldview_id: "placeholder",
};

const BASE_REQUEST: TransformRequest = {
  habit_text: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
  age_group: "7-12",
  regenerate: false,
};

function buildAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 80 },
  };
}

function newTransformer(opts?: { baseTemperature?: number }): QuestTransformer {
  const client = new Anthropic({ apiKey: "test" });
  return new QuestTransformer(client, "claude-test-model", opts?.baseTemperature ?? 0.7);
}

describe("QuestTransformer", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("해피 패스: 유효 JSON 응답을 TransformResponse로 반환한다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)),
    );

    const result = await newTransformer().transform(BASE_REQUEST);

    expect(result.quest.quest_name).toBe(VALID_QUEST_FIXTURE.quest_name);
    // 원본 습관 텍스트와 worldview_id는 요청값으로 강제 주입되어야 한다.
    expect(result.quest.original_habit).toBe(BASE_REQUEST.habit_text);
    expect(result.quest.worldview_id).toBe(BASE_REQUEST.worldview_id);
    expect(result.meta.model).toBe("claude-test-model");
    expect(result.meta.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.meta.prompt_tokens).toBe(120);
    expect(result.meta.completion_tokens).toBe(80);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Anthropic)).toHaveBeenCalled();
  });

  it("코드펜스(```json)로 래핑된 응답을 언랩해 파싱한다", async () => {
    const wrapped = "```json\n" + JSON.stringify(VALID_QUEST_FIXTURE) + "\n```";
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse(wrapped));

    const result = await newTransformer().transform(BASE_REQUEST);
    expect(result.quest.quest_name).toBe(VALID_QUEST_FIXTURE.quest_name);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("일반 코드펜스(```)로 래핑된 응답도 언랩한다", async () => {
    const wrapped = "```\n" + JSON.stringify(VALID_QUEST_FIXTURE) + "\n```";
    mockCreate.mockResolvedValueOnce(buildAnthropicResponse(wrapped));

    const result = await newTransformer().transform(BASE_REQUEST);
    expect(result.quest.quest_name).toBe(VALID_QUEST_FIXTURE.quest_name);
  });

  it("텍스트 블록이 없는 응답도 재시도 후 성공한다", async () => {
    mockCreate
      .mockResolvedValueOnce({ ...buildAnthropicResponse(""), content: [] })
      .mockResolvedValueOnce(buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)));

    const result = await newTransformer().transform(BASE_REQUEST);
    expect(result.quest.quest_name).toBe(VALID_QUEST_FIXTURE.quest_name);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("첫 호출 파싱 실패 → temperature 하향 재시도로 성공한다", async () => {
    mockCreate
      .mockResolvedValueOnce(buildAnthropicResponse("this is not json at all"))
      .mockResolvedValueOnce(buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)));

    const result = await newTransformer({ baseTemperature: 0.8 }).transform(BASE_REQUEST);
    expect(result.quest.quest_name).toBe(VALID_QUEST_FIXTURE.quest_name);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const firstCall = mockCreate.mock.calls[0]?.[0];
    const secondCall = mockCreate.mock.calls[1]?.[0];
    expect(firstCall.temperature).toBe(0.8);
    expect(secondCall.temperature).toBeLessThan(firstCall.temperature);
    expect(secondCall.temperature).toBeCloseTo(0.4, 5);
  });

  it("2회 모두 파싱 실패 → ParseError를 throw한다", async () => {
    mockCreate
      .mockResolvedValueOnce(buildAnthropicResponse("not json"))
      .mockResolvedValueOnce(buildAnthropicResponse("still not json"));

    await expect(newTransformer().transform(BASE_REQUEST)).rejects.toBeInstanceOf(ParseError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("JSON은 파싱되지만 스키마 위반이면 ValidationError를 throw한다", async () => {
    const invalid = JSON.stringify({ quest_name: "이름만 있음" });
    mockCreate
      .mockResolvedValueOnce(buildAnthropicResponse(invalid))
      .mockResolvedValueOnce(buildAnthropicResponse(invalid));

    await expect(newTransformer().transform(BASE_REQUEST)).rejects.toBeInstanceOf(ValidationError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("regenerate=true면 temperature가 base보다 높고 1.0 이하이다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)),
    );

    // baseTemperature=0.9 + boost=0.3 → clamp → 1.0 이하 보장
    await newTransformer({ baseTemperature: 0.9 }).transform({
      ...BASE_REQUEST,
      regenerate: true,
    });

    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.temperature).toBeGreaterThan(0.9);
    expect(call.temperature).toBeLessThanOrEqual(1.0);
  });

  it("regenerate=true 3회 호출 시 서로 다른 nonce가 system 프롬프트에 주입된다", async () => {
    const systems: string[] = [];
    mockCreate.mockImplementation(async (params: { system: string }) => {
      systems.push(params.system);
      return buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE));
    });

    const transformer = newTransformer();
    await transformer.transform({ ...BASE_REQUEST, regenerate: true });
    await transformer.transform({ ...BASE_REQUEST, regenerate: true });
    await transformer.transform({ ...BASE_REQUEST, regenerate: true });

    expect(systems).toHaveLength(3);
    expect(new Set(systems).size).toBe(3);
    for (const s of systems) {
      expect(s).toMatch(/regen:/);
    }
  });

  it("regenerate=false면 system 프롬프트에 regen 마커가 포함되지 않는다", async () => {
    mockCreate.mockResolvedValueOnce(
      buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)),
    );

    await newTransformer().transform(BASE_REQUEST);
    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.system).not.toMatch(/regen:/);
  });

  it("baseTemperature가 범위를 벗어나면 RangeError를 throw한다", () => {
    const client = new Anthropic({ apiKey: "test" });
    expect(() => new QuestTransformer(client, "model", 1.5)).toThrow(RangeError);
    expect(() => new QuestTransformer(client, "model", -0.1)).toThrow(RangeError);
  });
});
