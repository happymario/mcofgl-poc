// F-001 Task 12 — 평가 루브릭/템플릿 파일 구조 검증.
//
// 검증 책임:
// - 4개 평가 산출물 파일이 존재한다.
// - scoring-template.csv / blind-classification-template.csv 헤더가 계약된 컬럼과 일치한다.
// - README.md 안에 PoC 통과 기준 체크리스트 6개 항목이 모두 포함되어 있다.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EVAL_DIR = resolve(process.cwd(), "docs/evaluation");

const RUBRIC_MD = resolve(EVAL_DIR, "rubric.md");
const SCORING_CSV = resolve(EVAL_DIR, "scoring-template.csv");
const BLIND_CSV = resolve(EVAL_DIR, "blind-classification-template.csv");
const README_MD = resolve(EVAL_DIR, "README.md");

const SCORING_HEADER =
  "run_id,item_id,worldview_id,tone_score,intent_score,age_score,json_parse_ok,notes";

const BLIND_HEADER = "item_id,quest_name,description,guessed_worldview,confidence";

const REQUIRED_CHECKLIST_ITEMS = [
  "- [ ] 톤 일관성 합격률 ≥ 80%",
  "- [ ] 부모 의도 보존 합격률 ≥ 90%",
  "- [ ] 연령 적합성 합격률 ≥ 95%",
  "- [ ] JSON 파싱 성공률 ≥ 98%",
  "- [ ] 세계관 블라인드 구분 정확도 ≥ 90%",
  "- [ ] 경량 모델 평균 응답 시간 < 3초",
];

function readFirstLine(filePath: string): string {
  return readFileSync(filePath, "utf8").split("\n")[0].trimEnd();
}

describe("F-001 Task 12 — 평가 루브릭/템플릿", () => {
  it("docs/evaluation 디렉토리에 4개 산출물 파일이 모두 존재한다", () => {
    expect(existsSync(RUBRIC_MD)).toBe(true);
    expect(existsSync(SCORING_CSV)).toBe(true);
    expect(existsSync(BLIND_CSV)).toBe(true);
    expect(existsSync(README_MD)).toBe(true);
  });

  it("scoring-template.csv 헤더가 계약된 컬럼과 정확히 일치한다", () => {
    const header = readFirstLine(SCORING_CSV);
    expect(header).toBe(SCORING_HEADER);
  });

  it("blind-classification-template.csv 헤더가 계약된 컬럼과 정확히 일치한다", () => {
    const header = readFirstLine(BLIND_CSV);
    expect(header).toBe(BLIND_HEADER);
  });

  it("README.md 안에 PoC 통과 기준 체크리스트 6개 항목이 모두 포함되어 있다", () => {
    const readme = readFileSync(README_MD, "utf8");
    for (const item of REQUIRED_CHECKLIST_ITEMS) {
      expect(readme).toContain(item);
    }
  });
});
