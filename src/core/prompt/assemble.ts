// 스펙 §4.1 / G-4 — 시스템 프롬프트 조립기 (순수 함수).
//
// 계약:
// - 입력은 `{ bible, ageGroup?, characterContext? }` 한 덩어리의 "값"이다.
//   파일시스템·네트워크·시계·난수 등 모든 외부 I/O를 금지한다.
// - 동일 입력 → 동일 출력(결정론). 바이블을 교체하면 출력이 즉시 달라진다.
// - `load-bible.ts`를 import하지 않는다 (I/O와 조립 책임을 분리).
//
// 조립 순서 (고정):
//   1. COMMON_RULES 블록
//   2. 세계관 바이블 블록: background / tone(keywords·forbidden·examples) /
//      vocabulary / few-shot 예시(JSON)
//   3. 캐릭터 컨텍스트 블록 (characterContext가 있을 때만)
//   4. 연령 그룹 정보

import type { CharacterContext } from "../schemas/api.js";
import type { WorldviewBible } from "../schemas/worldview.js";
import { COMMON_RULES } from "./common-rules.js";

export interface AssembleOptions {
  bible: WorldviewBible;
  ageGroup?: string;
  characterContext?: CharacterContext;
}

const DEFAULT_AGE_GROUP = "7-12";

function renderBibleBlock(bible: WorldviewBible): string {
  const vocabularyLines = Object.entries(bible.vocabulary)
    .map(([from, to]) => `- ${from} → ${to}`)
    .join("\n");

  const fewShotBlocks = bible.few_shots
    .map((shot, index) => {
      const questJson = JSON.stringify(shot.quest, null, 2);
      return `예시 ${index + 1}\n입력 습관: ${shot.habit}\n출력 퀘스트:\n${questJson}`;
    })
    .join("\n\n");

  return [
    `[세계관 바이블: ${bible.id}]`,
    "",
    "## 배경",
    bible.background,
    "",
    "## 톤 & 무드",
    `- 키워드: ${bible.tone.keywords.join(", ")}`,
    `- 금지 표현: ${bible.tone.forbidden.join(", ")}`,
    "- 예시 문장:",
    ...bible.tone.examples.map((line) => `  - ${line}`),
    "",
    "## 어휘 치환 사전",
    vocabularyLines,
    "",
    "## Few-shot 예시",
    fewShotBlocks,
  ].join("\n");
}

function renderCharacterBlock(character: CharacterContext): string {
  return [
    "[캐릭터 컨텍스트]",
    `- 이름: ${character.name}`,
    `- 클래스: ${character.class}`,
    `- 레벨: ${character.level}`,
  ].join("\n");
}

function renderAgeBlock(ageGroup: string): string {
  return [
    "[연령 그룹]",
    `- 대상 연령: ${ageGroup}세`,
    "- 위 연령대가 이해할 수 있는 쉬운 어휘·짧은 문장으로 생성할 것.",
  ].join("\n");
}

export function assembleSystemPrompt(options: AssembleOptions): string {
  const { bible, ageGroup, characterContext } = options;
  const effectiveAgeGroup = ageGroup ?? DEFAULT_AGE_GROUP;

  const sections: string[] = [
    COMMON_RULES,
    renderBibleBlock(bible),
  ];

  if (characterContext !== undefined) {
    sections.push(renderCharacterBlock(characterContext));
  }

  sections.push(renderAgeBlock(effectiveAgeGroup));

  return sections.join("\n\n");
}
