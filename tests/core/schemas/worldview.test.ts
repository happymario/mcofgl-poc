import { describe, expect, it } from "vitest";
import { WorldviewBibleSchema } from "../../../src/core/schemas/worldview.js";

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

const baseWorldview = {
  id: "isekai-academy-v1",
  background: "마법과 검술이 공존하는 아카데미 세계.",
  tone: {
    keywords: ["용기", "우정", "성장"],
    forbidden: ["폭력 묘사", "공포"],
    examples: ["모험가여, 오늘도 함께 나아가자!"],
  },
  vocabulary: {
    일어나기: "마나 충전 의식",
    밥먹기: "기력 보충",
  },
  npcs: [
    {
      name: "멘토 아리아",
      role: "안내자",
      personality: "따뜻하고 단호하다",
      speech_style: "존댓말, 격려조",
    },
  ],
  few_shots: [
    {
      habit: "아침 7시에 일어나기",
      quest: sampleQuest,
    },
  ],
};

describe("WorldviewBibleSchema", () => {
  it("유효한 WorldviewBible을 파싱한다", () => {
    const parsed = WorldviewBibleSchema.parse(baseWorldview);
    expect(parsed.id).toBe("isekai-academy-v1");
    expect(parsed.few_shots[0]?.quest.quest_name).toBe("새벽 마나 충전 의식");
  });

  it("few_shots의 quest 필드가 QuestSchema를 위반하면 거부한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      few_shots: [
        {
          habit: "아침 7시에 일어나기",
          quest: { ...sampleQuest, category: "게임" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("npcs 빈 배열을 허용한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      npcs: [],
    });
    expect(result.success).toBe(true);
  });

  it("vocabulary 빈 객체를 허용한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      vocabulary: {},
    });
    expect(result.success).toBe(true);
  });

  it("few_shots 빈 배열을 허용한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      few_shots: [],
    });
    expect(result.success).toBe(true);
  });

  it("tone.keywords/forbidden/examples는 문자열 배열이어야 한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      tone: { ...baseWorldview.tone, keywords: [123] },
    });
    expect(result.success).toBe(false);
  });

  it("id 누락 시 실패한다", () => {
    const { id: _id, ...rest } = baseWorldview;
    const result = WorldviewBibleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("tone 누락 시 실패한다", () => {
    const { tone: _tone, ...rest } = baseWorldview;
    const result = WorldviewBibleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("npc 항목의 필수 필드(name/role/personality/speech_style)를 검증한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      npcs: [{ name: "아리아", role: "안내자", personality: "따뜻하다" }],
    });
    expect(result.success).toBe(false);
  });

  it("vocabulary의 빈 문자열 키를 거부한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      vocabulary: { "": "길드 기지" },
    });
    expect(result.success).toBe(false);
  });

  it("vocabulary의 공백만으로 이루어진 키를 거부한다", () => {
    const result = WorldviewBibleSchema.safeParse({
      ...baseWorldview,
      vocabulary: { "   ": "기력 보충" },
    });
    expect(result.success).toBe(false);
  });
});
