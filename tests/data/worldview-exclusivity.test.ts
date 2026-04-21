// 두 세계관 바이블(kingdom_of_light, starlight_magic_school)이 서로의 배타적 용어를
// 오염 없이 분리 유지하는지 검증한다.
//
// PRD §5.2 / §6.3 R-003: 세계관 블라인드 구분 정확도 90%+ 달성을 위해
// 두 세계관의 어휘가 서로 섞이면 안 된다.
//
// 검증 전략:
// 1) forbidden 목록의 **최소 5개 이상**이 상대 바이블의 vocabulary 값에 substring으로
//    등장하는지 확인한다 (sanity check). forbidden에는 배경/예시에만 쓰이는
//    세계관 고유어(예: "왕국", "안개")도 포함될 수 있으므로 "전원 등장"이 아닌
//    "최소 N개 이상 등장"으로 제약을 완화한다.
// 2) vocabulary의 **키**는 반대로 상대 forbidden 단어를 포함해선 안 된다.
//    (키는 현실 한국어이므로 상대 세계관 고유어가 substring으로 섞이면 버그)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WorldviewBibleSchema } from "../../src/core/schemas/worldview.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "..", "..");
const worldviewsDir = join(repoRoot, "data", "worldviews");

const kingdomRaw = readFileSync(join(worldviewsDir, "kingdom_of_light.json"), "utf-8");
const starlightRaw = readFileSync(
  join(worldviewsDir, "starlight_magic_school.json"),
  "utf-8",
);

const kingdom = WorldviewBibleSchema.parse(JSON.parse(kingdomRaw));
const starlight = WorldviewBibleSchema.parse(JSON.parse(starlightRaw));

/**
 * forbidden 목록의 각 단어가 상대 바이블의 vocabulary 값 중 어디엔가
 * substring으로 등장하는지 확인한다. 등장한 단어 개수를 반환한다.
 */
function countForbiddenHitsInVocabulary(
  forbidden: readonly string[],
  vocabularyValues: readonly string[],
): { hits: string[]; misses: string[] } {
  const hits: string[] = [];
  const misses: string[] = [];
  for (const word of forbidden) {
    const matched = vocabularyValues.some((value) => value.includes(word));
    if (matched) hits.push(word);
    else misses.push(word);
  }
  return { hits, misses };
}

describe("worldview exclusivity", () => {
  it("두 바이블 모두 WorldviewBibleSchema를 통과한다", () => {
    // 파일 읽기 단계에서 이미 parse 됨. 여기서는 id/few_shots 등 최소 필드만 재확인.
    expect(kingdom.id).toBe("kingdom_of_light");
    expect(starlight.id).toBe("starlight_magic_school");
    expect(kingdom.few_shots.length).toBeGreaterThan(0);
    expect(starlight.few_shots.length).toBeGreaterThan(0);
  });

  it("두 바이블의 id가 서로 다르다", () => {
    expect(kingdom.id).not.toBe(starlight.id);
  });

  it("starlight.tone.forbidden 단어 중 최소 5개는 kingdom.vocabulary 값에 등장한다 (배타성 sanity check)", () => {
    const kingdomVocabValues = Object.values(kingdom.vocabulary);
    const { hits } = countForbiddenHitsInVocabulary(
      starlight.tone.forbidden,
      kingdomVocabValues,
    );
    expect(
      hits.length,
      `starlight.forbidden 중 kingdom.vocabulary 값에 등장하는 단어: ${hits.join(", ")}`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("kingdom.tone.forbidden 단어 중 최소 5개는 starlight.vocabulary 값에 등장한다 (배타성 sanity check)", () => {
    const starlightVocabValues = Object.values(starlight.vocabulary);
    const { hits } = countForbiddenHitsInVocabulary(
      kingdom.tone.forbidden,
      starlightVocabValues,
    );
    expect(
      hits.length,
      `kingdom.forbidden 중 starlight.vocabulary 값에 등장하는 단어: ${hits.join(", ")}`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("starlight.vocabulary 키에는 kingdom.forbidden 단어가 들어가지 않는다 (키는 현실 용어)", () => {
    const starlightKeys = Object.keys(starlight.vocabulary);
    for (const forbidden of kingdom.tone.forbidden) {
      const polluted = starlightKeys.filter((key) => key.includes(forbidden));
      expect(
        polluted,
        `starlight.vocabulary 키에 kingdom.forbidden 단어("${forbidden}")가 섞임: ${polluted.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("kingdom.vocabulary 키에는 starlight.forbidden 단어가 들어가지 않는다 (키는 현실 용어)", () => {
    const kingdomKeys = Object.keys(kingdom.vocabulary);
    for (const forbidden of starlight.tone.forbidden) {
      const polluted = kingdomKeys.filter((key) => key.includes(forbidden));
      expect(
        polluted,
        `kingdom.vocabulary 키에 starlight.forbidden 단어("${forbidden}")가 섞임: ${polluted.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("starlight few_shots는 kingdom few_shots와 동일한 습관을 3개 이상 공유한다 (블라인드 테스트 목적)", () => {
    const kingdomHabits = new Set(kingdom.few_shots.map((fs) => fs.habit));
    const overlappingHabits = starlight.few_shots
      .map((fs) => fs.habit)
      .filter((habit) => kingdomHabits.has(habit));
    expect(
      overlappingHabits.length,
      `공유 습관 목록: ${overlappingHabits.join(", ")}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("starlight few_shots의 quest.worldview_id는 모두 'starlight_magic_school'이다", () => {
    for (const fs of starlight.few_shots) {
      expect(fs.quest.worldview_id).toBe("starlight_magic_school");
    }
  });

  it("starlight.vocabulary는 30개 이상 엔트리를 보유한다 (PRD §5.1)", () => {
    expect(Object.keys(starlight.vocabulary).length).toBeGreaterThanOrEqual(30);
  });

  it("starlight.tone.keywords는 5~8개다 (PRD §5.1)", () => {
    expect(starlight.tone.keywords.length).toBeGreaterThanOrEqual(5);
    expect(starlight.tone.keywords.length).toBeLessThanOrEqual(8);
  });

  it("starlight.tone.forbidden은 최소 5개 (kingdom_of_light 전용 용어)", () => {
    expect(starlight.tone.forbidden.length).toBeGreaterThanOrEqual(5);
  });

  it("starlight.tone.examples는 정확히 3개다 (PRD §5.1)", () => {
    expect(starlight.tone.examples.length).toBe(3);
  });

  it("starlight.npcs는 3~5명이다 (PRD §5.1)", () => {
    expect(starlight.npcs.length).toBeGreaterThanOrEqual(3);
    expect(starlight.npcs.length).toBeLessThanOrEqual(5);
  });

  it("starlight.few_shots는 정확히 5개다 (PRD §5.1)", () => {
    expect(starlight.few_shots.length).toBe(5);
  });

  it("starlight.background은 200~300자 사이다 (PRD §5.1)", () => {
    const len = starlight.background.length;
    expect(len).toBeGreaterThanOrEqual(200);
    expect(len).toBeLessThanOrEqual(300);
  });
});
