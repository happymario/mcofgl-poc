import { describe, expect, it } from "vitest";
import {
  TransformRequestSchema,
  TransformResponseSchema,
} from "../../../src/core/schemas/api.js";

const sampleQuest = {
  quest_name: "새벽 마나 충전 의식",
  description: "7시에 눈을 뜨고 스트레칭으로 마나를 충전한다.",
  category: "기상/취침" as const,
  stat_mapping: { 체력: 2 },
  reward: { exp: 30, coin: 10 },
  suggested_grade: "B" as const,
  mandatory_suitability: "high" as const,
  original_habit: "아침 7시에 일어나기",
  worldview_id: "isekai-academy-v1",
};

describe("TransformRequestSchema", () => {
  it("최소 필드(habit_text, worldview_id)만으로도 통과한다", () => {
    const parsed = TransformRequestSchema.parse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
    });
    expect(parsed.habit_text).toBe("아침 7시에 일어나기");
    expect(parsed.worldview_id).toBe("isekai-academy-v1");
  });

  it("age_group 기본값은 '7-12'이다", () => {
    const parsed = TransformRequestSchema.parse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
    });
    expect(parsed.age_group).toBe("7-12");
  });

  it("regenerate 기본값은 false이다", () => {
    const parsed = TransformRequestSchema.parse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
    });
    expect(parsed.regenerate).toBe(false);
  });

  it("character_context 생략을 허용한다", () => {
    const parsed = TransformRequestSchema.parse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
    });
    expect(parsed.character_context).toBeUndefined();
  });

  it("character_context 제공 시 name/class/level을 검증한다", () => {
    const parsed = TransformRequestSchema.parse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
      character_context: { name: "루나", class: "마법사", level: 3 },
    });
    expect(parsed.character_context?.level).toBe(3);
  });

  it("character_context의 level이 number가 아니면 거부한다", () => {
    const result = TransformRequestSchema.safeParse({
      habit_text: "아침 7시에 일어나기",
      worldview_id: "isekai-academy-v1",
      character_context: { name: "루나", class: "마법사", level: "3" },
    });
    expect(result.success).toBe(false);
  });

  it("habit_text 빈 문자열을 거부한다", () => {
    const result = TransformRequestSchema.safeParse({
      habit_text: "",
      worldview_id: "isekai-academy-v1",
    });
    expect(result.success).toBe(false);
  });

  it("worldview_id 누락 시 실패한다", () => {
    const result = TransformRequestSchema.safeParse({
      habit_text: "아침 7시에 일어나기",
    });
    expect(result.success).toBe(false);
  });

  it("habit_text 누락 시 실패한다", () => {
    const result = TransformRequestSchema.safeParse({
      worldview_id: "isekai-academy-v1",
    });
    expect(result.success).toBe(false);
  });

  it("habit_text 500자 초과를 거부한다", () => {
    const result = TransformRequestSchema.safeParse({
      habit_text: "가".repeat(501),
      worldview_id: "isekai-academy-v1",
    });
    expect(result.success).toBe(false);
  });

  it("habit_text 500자는 허용한다", () => {
    const result = TransformRequestSchema.safeParse({
      habit_text: "가".repeat(500),
      worldview_id: "isekai-academy-v1",
    });
    expect(result.success).toBe(true);
  });
});

describe("TransformResponseSchema", () => {
  it("유효한 응답을 파싱한다", () => {
    const parsed = TransformResponseSchema.parse({
      quest: sampleQuest,
      meta: {
        model: "claude-sonnet-4-5",
        latency_ms: 1234,
        prompt_tokens: 800,
        completion_tokens: 300,
      },
    });
    expect(parsed.quest.quest_name).toBe("새벽 마나 충전 의식");
    expect(parsed.meta.model).toBe("claude-sonnet-4-5");
  });

  it("quest 필드가 QuestSchema를 위반하면 실패한다", () => {
    const result = TransformResponseSchema.safeParse({
      quest: { ...sampleQuest, suggested_grade: "F" },
      meta: {
        model: "claude-sonnet-4-5",
        latency_ms: 100,
        prompt_tokens: 10,
        completion_tokens: 10,
      },
    });
    expect(result.success).toBe(false);
  });

  it("meta 필수 필드(model/latency_ms/prompt_tokens/completion_tokens)를 검증한다", () => {
    const result = TransformResponseSchema.safeParse({
      quest: sampleQuest,
      meta: {
        model: "claude-sonnet-4-5",
        latency_ms: 100,
        prompt_tokens: 10,
      },
    });
    expect(result.success).toBe(false);
  });
});
