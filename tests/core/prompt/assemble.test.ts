// assembleSystemPrompt 순수 함수 계약 테스트.
//
// 스펙 G-4: 공통 규칙 + 세계관 바이블 + (선택적) 캐릭터 컨텍스트를 받아
// 결정론적 시스템 프롬프트 문자열을 반환한다. 바이블 교체만으로 출력이 달라져야 한다.
//
// 외부 I/O 금지 원칙: 이 테스트는 파일시스템 기반 로더(load-bible.ts)를
// 사용하지 않고, JSON 파일을 직접 읽어 파싱한 뒤 assembleSystemPrompt에
// bible 파라미터로 주입한다. assemble.ts가 load-bible.ts에 의존하지 않음을
// 간접적으로 강제한다.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../../../src/core/prompt/assemble.js";
import { COMMON_RULES } from "../../../src/core/prompt/common-rules.js";
import { type CharacterContext } from "../../../src/core/schemas/api.js";
import {
  type WorldviewBible,
  WorldviewBibleSchema,
} from "../../../src/core/schemas/worldview.js";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");
const worldviewsDir = join(repoRoot, "data", "worldviews");

function readBible(fileName: string): WorldviewBible {
  const raw = readFileSync(join(worldviewsDir, fileName), "utf-8");
  return WorldviewBibleSchema.parse(JSON.parse(raw));
}

const kingdom = readBible("kingdom_of_light.json");
const starlight = readBible("starlight_magic_school.json");

describe("assembleSystemPrompt", () => {
  it("동일 입력이면 동일 문자열을 반환한다 (결정론)", () => {
    const first = assembleSystemPrompt({ bible: kingdom });
    const second = assembleSystemPrompt({ bible: kingdom });
    expect(first).toBe(second);
  });

  it("바이블을 교체하면 출력이 달라진다 (G-4)", () => {
    const kingdomPrompt = assembleSystemPrompt({ bible: kingdom });
    const starlightPrompt = assembleSystemPrompt({ bible: starlight });
    expect(kingdomPrompt).not.toBe(starlightPrompt);
    // 핵심 어휘 일부가 각 세계관에만 등장하는지 교차 확인
    expect(kingdomPrompt).toContain("길드 기지");
    expect(kingdomPrompt).not.toContain("별빛 기숙사");
    expect(starlightPrompt).toContain("별빛 기숙사");
    expect(starlightPrompt).not.toContain("길드 기지");
  });

  it("characterContext를 생략해도 정상 문자열을 반환한다", () => {
    const prompt = assembleSystemPrompt({ bible: kingdom });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("COMMON_RULES의 핵심 문구가 출력에 포함된다", () => {
    const prompt = assembleSystemPrompt({ bible: kingdom });
    expect(prompt).toContain("[공통 규칙]");
    expect(prompt).toContain("긍정 전용");
    // 정의한 상수 전체가 들어가야 한다 (중요 계약)
    expect(prompt).toContain(COMMON_RULES);
  });

  it("few-shot 예시의 quest_name이 출력에 포함된다", () => {
    const prompt = assembleSystemPrompt({ bible: kingdom });
    const firstQuestName = kingdom.few_shots[0]?.quest.quest_name;
    expect(firstQuestName).toBeDefined();
    expect(prompt).toContain(firstQuestName as string);
  });

  it("characterContext가 있으면 캐릭터 이름이 출력에 포함된다", () => {
    const character: CharacterContext = {
      name: "아르텔",
      class: "용사",
      level: 7,
    };
    const withCharacter = assembleSystemPrompt({
      bible: kingdom,
      characterContext: character,
    });
    const withoutCharacter = assembleSystemPrompt({ bible: kingdom });
    expect(withCharacter).toContain("아르텔");
    // 캐릭터 컨텍스트 유무에 따라 출력이 달라져야 한다
    expect(withCharacter).not.toBe(withoutCharacter);
  });

  it("세계관 바이블의 background가 출력에 포함된다", () => {
    const prompt = assembleSystemPrompt({ bible: kingdom });
    expect(prompt).toContain(kingdom.background);
  });

  it("ageGroup 기본값이 연령 정보로 포함된다", () => {
    const prompt = assembleSystemPrompt({ bible: kingdom });
    expect(prompt).toContain("7-12");
  });
});
