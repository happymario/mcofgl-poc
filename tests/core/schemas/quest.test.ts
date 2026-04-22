import { describe, expect, it } from "vitest";
import { QuestSchema } from "../../../src/core/schemas/quest.js";

// 스펙 §3.3 기준 샘플 Quest — 모든 필수 필드 충족.
const baseQuest = {
  quest_name: "새벽 마나 충전 의식",
  description: "7시에 눈을 뜨고 스트레칭으로 마나를 충전한다.",
  category: "기상/취침" as const,
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 축복" },
  suggested_grade: "B" as const,
  mandatory_suitability: "high" as const,
  original_habit: "아침 7시에 일어나기",
  worldview_id: "isekai-academy-v1",
};

describe("QuestSchema", () => {
  it("유효한 Quest 객체를 그대로 파싱한다", () => {
    const parsed = QuestSchema.parse(baseQuest);
    expect(parsed).toEqual(baseQuest);
  });

  it("buff가 생략된 reward도 허용한다 (buff는 optional)", () => {
    const { buff: _buff, ...rewardWithoutBuff } = baseQuest.reward;
    const parsed = QuestSchema.parse({
      ...baseQuest,
      reward: rewardWithoutBuff,
    });
    expect(parsed.reward.buff).toBeUndefined();
  });

  it("category enum 밖의 값은 거부한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      category: "게임",
    });
    expect(result.success).toBe(false);
  });

  it("category 허용 값 8종을 모두 수용한다", () => {
    const categories = [
      "기상/취침",
      "위생",
      "식사",
      "학습",
      "운동/외출",
      "정리정돈",
      "사회성",
      "생활습관",
    ] as const;
    for (const category of categories) {
      const result = QuestSchema.safeParse({ ...baseQuest, category });
      expect(result.success).toBe(true);
    }
  });

  it("stat_mapping에 허용되지 않은 스탯 키가 있으면 거부한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      stat_mapping: { 체력: 1, 행운: 2 },
    });
    expect(result.success).toBe(false);
  });

  it("stat_mapping 빈 객체를 허용한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      stat_mapping: {},
    });
    expect(result.success).toBe(true);
  });

  it("stat_mapping 허용 스탯 4종을 모두 수용한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      stat_mapping: { 체력: 1, 지혜: 1, 매력: 1, 근성: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("suggested_grade enum(D/C/B/A/S) 밖의 값은 거부한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      suggested_grade: "F",
    });
    expect(result.success).toBe(false);
  });

  it("suggested_grade 허용 값 5종(D/C/B/A/S)을 모두 수용한다", () => {
    const grades = ["D", "C", "B", "A", "S"] as const;
    for (const suggested_grade of grades) {
      const result = QuestSchema.safeParse({
        ...baseQuest,
        suggested_grade,
      });
      expect(result.success).toBe(true);
    }
  });

  it("mandatory_suitability enum(high/medium/low) 밖의 값은 거부한다", () => {
    const result = QuestSchema.safeParse({
      ...baseQuest,
      mandatory_suitability: "critical",
    });
    expect(result.success).toBe(false);
  });

  it("quest_name 누락 시 실패한다", () => {
    const { quest_name: _name, ...rest } = baseQuest;
    const result = QuestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("description 누락 시 실패한다", () => {
    const { description: _desc, ...rest } = baseQuest;
    const result = QuestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("reward 누락 시 실패한다", () => {
    const { reward: _reward, ...rest } = baseQuest;
    const result = QuestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("worldview_id 누락 시 실패한다", () => {
    const { worldview_id: _wv, ...rest } = baseQuest;
    const result = QuestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("original_habit 누락 시 실패한다", () => {
    const { original_habit: _oh, ...rest } = baseQuest;
    const result = QuestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
