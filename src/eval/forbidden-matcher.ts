// F-001 Task 8 — 금지어 검출기.
//
// 스펙 §7.2 평가 파이프라인의 첫 게이트.
// 주어진 본문(text)에 금지어 리스트 중 어느 하나라도 포함되어 있는지 검사한다.
// 정규식 이스케이프 이슈를 피하고 금지어에 특수문자(`.`, `+` 등)가 들어와도
// 리터럴 매칭되도록 소문자 변환 후 `includes`로 비교한다.

export interface ForbiddenCheckResult {
  hit: boolean;
  matches: string[];
}

export function checkForbidden(
  text: string,
  forbiddenList: string[],
): ForbiddenCheckResult {
  if (forbiddenList.length === 0) {
    return { hit: false, matches: [] };
  }

  const lowerText = text.toLowerCase();
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const term of forbiddenList) {
    if (seen.has(term)) continue;
    const lowerTerm = term.toLowerCase();
    if (lowerTerm.length === 0) continue;
    if (lowerText.includes(lowerTerm)) {
      seen.add(term);
      matches.push(term);
    }
  }

  return { hit: matches.length > 0, matches };
}
