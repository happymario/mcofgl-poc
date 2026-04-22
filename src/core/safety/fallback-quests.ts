// F-003 Task 5 — 세계관별 빌트인 범용 폴백 퀘스트.
//
// 책임:
// - `FallbackSelector`의 최종 안전망. 유사도 검색 및 랜덤 선택이 모두 실패해도
//   세계관별 "아무나 받아도 안전한" 퀘스트 1건을 즉시 반환할 수 있게 한다.
// - PoC 범위(2개 세계관)에 맞춰 인라인 상수로 유지하고, 파일 I/O나 DB 조회는 하지 않는다.
//
// 설계:
// - `BUILTIN_QUESTS`의 각 엔트리는 QuestSchema의 모든 필수 필드를 포함해
//   `QuestSchema.parse`가 즉시 성공한다 (Task 5 Completion Criteria).
// - habit_text는 현재 사용하지 않지만, 추후 빌트인 퀘스트를 습관에 맞게 미세 조정할
//   여지를 남기기 위해 시그니처에 유지한다.
// - 모르는 worldview_id는 즉시 Error — 상위 파이프라인이 fail-closed로 처리한다.

import type { Quest } from "../schemas/quest.js";

// 세계관별 범용 퀘스트 1건. PoC 단계에서는 인라인 상수로 관리하며,
// 세계관이 더 늘어나면 워크플로우 JSON으로 외부화할 수 있다.
const BUILTIN_QUESTS: Record<string, Quest> = {
  kingdom_of_light: {
    quest_name: "여명의 단련",
    description: "용사여, 오늘도 작은 습관 하나로 빛의 왕국을 지켜내자.",
    category: "생활습관",
    stat_mapping: { 근성: 1 },
    reward: { exp: 10, coin: 5, buff: "집중력 +1" },
    suggested_grade: "D",
    mandatory_suitability: "medium",
    original_habit: "기본 습관",
    worldview_id: "kingdom_of_light",
  },
  starlight_magic_school: {
    quest_name: "별빛 마법 연습",
    description: "매일의 작은 연습이 모여 너만의 별빛 마법이 된다.",
    category: "학습",
    stat_mapping: { 지혜: 1 },
    reward: { exp: 10, coin: 5, buff: "마나 +1" },
    suggested_grade: "D",
    mandatory_suitability: "medium",
    original_habit: "기본 습관",
    worldview_id: "starlight_magic_school",
  },
};

export function getBuiltinFallbackQuest(
  worldviewId: string,
  _habitText: string,
): Quest {
  const quest = BUILTIN_QUESTS[worldviewId];
  if (!quest) {
    throw new Error(
      `getBuiltinFallbackQuest: 알 수 없는 worldview_id "${worldviewId}" — 빌트인 퀘스트가 없습니다`,
    );
  }
  return quest;
}
