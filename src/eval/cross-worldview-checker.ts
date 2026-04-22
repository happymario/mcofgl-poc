// F-001 Task 8 — 세계관 교차 혼입 검사기.
//
// 스펙 §7.2 평가 파이프라인 — 변환된 퀘스트 본문이 다른 세계관의 금기 용어를
// 사용하고 있지 않은지 확인한다.
// 정책:
// - otherBible.tone.forbidden에 정의된 키워드가 text에 등장하면 leaked에 포함.
// - 동일 바이블과 비교(ownBible.id === otherBible.id)는 자기 자신 비교이므로
//   혼입 판정 대상이 아니다 → 빈 leaked 반환.
// - 대소문자는 구분하지 않고 부분 문자열 매칭 (forbidden-matcher와 동일한 기준).

import type { WorldviewBible } from "../core/schemas/worldview.js";
import { checkForbidden } from "./forbidden-matcher.js";

export interface CrossContaminationResult {
  leaked: string[];
}

export function detectCrossContamination(
  text: string,
  ownBible: WorldviewBible,
  otherBible: WorldviewBible,
): CrossContaminationResult {
  // 자기 자신과의 비교는 교차 혼입으로 간주하지 않는다.
  if (ownBible.id === otherBible.id) {
    return { leaked: [] };
  }

  const { matches } = checkForbidden(text, otherBible.tone.forbidden);
  return { leaked: matches };
}
