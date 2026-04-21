// F-001 Task 8 — forbidden-matcher 계약 테스트.
//
// 검증 책임:
// - 빈 금지어 리스트 처리
// - 단순 부분 문자열 매칭
// - 동일 금지어가 본문에 여러 번 등장해도 matches는 유니크
// - 대소문자 무시 매칭
// - 정규식 특수문자가 포함된 금지어(예: "P.E.", "C++")도 안전하게 매칭

import { describe, expect, it } from "vitest";
import { checkForbidden } from "../../src/eval/forbidden-matcher.js";

describe("checkForbidden", () => {
  it("빈 금지어 리스트면 hit=false, matches=[]를 반환한다", () => {
    const result = checkForbidden("아무 텍스트나", []);
    expect(result.hit).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("본문에 포함된 금지어가 없으면 hit=false", () => {
    const result = checkForbidden("평온한 아침이었다", ["기숙사", "교복"]);
    expect(result.hit).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("본문에 포함된 금지어를 모두 matches로 반환한다", () => {
    const result = checkForbidden(
      "오늘은 기숙사에서 교복을 갈아입었다",
      ["기숙사", "교복", "사물함"],
    );
    expect(result.hit).toBe(true);
    expect(result.matches).toEqual(expect.arrayContaining(["기숙사", "교복"]));
    expect(result.matches).not.toContain("사물함");
    expect(result.matches).toHaveLength(2);
  });

  it("동일 금지어가 본문에 여러 번 등장해도 matches에는 한 번만 포함된다", () => {
    const result = checkForbidden(
      "기숙사에서 나와 다시 기숙사로 돌아갔다",
      ["기숙사"],
    );
    expect(result.hit).toBe(true);
    expect(result.matches).toEqual(["기숙사"]);
  });

  it("대소문자를 구분하지 않는다", () => {
    const result = checkForbidden("Hello WORLD", ["hello", "World"]);
    expect(result.hit).toBe(true);
    expect(result.matches).toEqual(expect.arrayContaining(["hello", "World"]));
    expect(result.matches).toHaveLength(2);
  });

  it("정규식 특수문자가 포함된 금지어도 리터럴로 매칭한다", () => {
    const result = checkForbidden("체육 과목은 P.E. 수업이고 C++도 배운다", [
      "P.E.",
      "C++",
      "Java.",
    ]);
    expect(result.hit).toBe(true);
    expect(result.matches).toEqual(expect.arrayContaining(["P.E.", "C++"]));
    expect(result.matches).not.toContain("Java.");
  });

  it("금지어 리스트에 중복이 있어도 결과 matches는 유니크하다", () => {
    const result = checkForbidden("기숙사", ["기숙사", "기숙사"]);
    expect(result.matches).toEqual(["기숙사"]);
  });
});
