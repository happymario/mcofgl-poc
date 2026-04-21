// 스펙 §9.1 — 50개 습관 샘플 세트의 구조 검증.
//
// 분포 요건: simple 20 / timed 10 / complex 10 / ambiguous 5 / edge 5.
// 엣지 케이스 5건에는 이모지, 영어 혼용, 매우 긴 입력(50자 이상)이 각각
// 최소 1건씩 포함되어야 한다 (스펙 §9.1 "매우 긴 입력, 이모지 포함, 영어 혼용").
//
// 검증 전략: readFileSync + JSON.parse로 파일을 읽고 Zod 파싱 없이 순수
// 구조만 확인한다(러너/프롬프트는 habit 텍스트만 소비하므로 이 데이터에 대한
// 런타임 Zod 스키마는 필요하지 않다). expected_category는 QuestCategorySchema
// enum과 동일한 값으로 고정하여 추후 러너에서 카테고리 오분류 지표 계산에
// 재사용할 수 있게 한다.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QuestCategorySchema } from "../../src/core/schemas/quest.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "..", "..");
const habitsPath = join(repoRoot, "data", "habits", "sample-50.json");

type HabitType = "simple" | "timed" | "complex" | "ambiguous" | "edge";

interface HabitSample {
  readonly id: string;
  readonly text: string;
  readonly type: HabitType;
  readonly expected_category: string;
}

const raw = readFileSync(habitsPath, "utf-8");
const habits = JSON.parse(raw) as HabitSample[];

const VALID_TYPES: readonly HabitType[] = [
  "simple",
  "timed",
  "complex",
  "ambiguous",
  "edge",
];

const VALID_CATEGORIES = new Set(QuestCategorySchema.options);

// Extended_Pictographic은 진짜 "그림 이모지"만 매칭한다. \p{Emoji}는 숫자와 `#`도
// 매칭하므로 부적절.
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const ENGLISH_RE = /[A-Za-z]/;
const ID_RE = /^h\d{3}$/;

describe("habit sample-50 dataset (spec §9.1)", () => {
  it("총 50건이다", () => {
    expect(habits.length).toBe(50);
  });

  it("type 분포가 정확히 simple 20 / timed 10 / complex 10 / ambiguous 5 / edge 5 이다", () => {
    const counts: Record<HabitType, number> = {
      simple: 0,
      timed: 0,
      complex: 0,
      ambiguous: 0,
      edge: 0,
    };
    for (const habit of habits) {
      counts[habit.type] += 1;
    }
    expect(counts).toEqual({
      simple: 20,
      timed: 10,
      complex: 10,
      ambiguous: 5,
      edge: 5,
    });
  });

  it("모든 type이 유효한 enum 값이다", () => {
    for (const habit of habits) {
      expect(
        VALID_TYPES.includes(habit.type),
        `invalid type on ${habit.id}: ${habit.type}`,
      ).toBe(true);
    }
  });

  it("id는 중복이 없고 h001~h050 형식이다", () => {
    const ids = habits.map((h) => h.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(habits.length);
    for (const id of ids) {
      expect(ID_RE.test(id), `invalid id format: ${id}`).toBe(true);
    }
  });

  it("모든 text가 비어있지 않다", () => {
    for (const habit of habits) {
      expect(habit.text.trim().length, `empty text on ${habit.id}`).toBeGreaterThan(0);
    }
  });

  it("모든 expected_category가 QuestCategorySchema enum 값이다", () => {
    for (const habit of habits) {
      expect(
        VALID_CATEGORIES.has(habit.expected_category as never),
        `invalid expected_category on ${habit.id}: ${habit.expected_category}`,
      ).toBe(true);
    }
  });

  it("8개 카테고리 전부를 최소 1건 이상 커버한다 (스펙 §9.1 '카테고리별 균등 분배')", () => {
    const covered = new Set(habits.map((h) => h.expected_category));
    for (const category of QuestCategorySchema.options) {
      expect(covered.has(category), `category not covered: ${category}`).toBe(true);
    }
  });

  it("엣지 케이스 5건에 이모지 포함이 최소 1건 있다", () => {
    const edges = habits.filter((h) => h.type === "edge");
    expect(edges.length).toBe(5);
    const withEmoji = edges.filter((h) => EMOJI_RE.test(h.text));
    expect(
      withEmoji.length,
      `emoji edge cases: ${withEmoji.map((h) => h.id).join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("엣지 케이스 5건에 영어 혼용이 최소 1건 있다", () => {
    const edges = habits.filter((h) => h.type === "edge");
    const withEnglish = edges.filter((h) => ENGLISH_RE.test(h.text));
    expect(
      withEnglish.length,
      `english edge cases: ${withEnglish.map((h) => h.id).join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("엣지 케이스 5건에 매우 긴 입력(50자 이상)이 최소 1건 있다", () => {
    const edges = habits.filter((h) => h.type === "edge");
    const longOnes = edges.filter((h) => h.text.length >= 50);
    expect(
      longOnes.length,
      `long edge cases: ${longOnes.map((h) => `${h.id}(${h.text.length})`).join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
  });
});
