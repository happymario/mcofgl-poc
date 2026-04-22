// 스펙 §F-003 — Safety Filter Layer 1: 룰 기반 차단/치환 엔진.
//
// 입력: Quest (quest_name + description)
// 출력: RuleFilterResult — pass / replaced / block_and_fallback
//
// 처리 순서:
// 1) 검사 텍스트 생성: `quest_name + "\n" + description`
// 2) allowlist 항목을 빈 문자열로 치환해 "정당한 RPG 어휘"를 매칭에서 제외
//    (긴 항목부터 제거해 "어둠의 안개" > "어둠" 순서 불변성 유지)
// 3) block_and_fallback 카테고리의 키워드/패턴 매칭 → 히트 시 즉시 차단
// 4) replace 카테고리의 키워드 매칭 → description만 치환
// 5) 치환이 일어났다면 치환된 텍스트로 block 재검사 → 잔여 차단 키워드 격상
// 6) 아무 히트도 없으면 pass
//
// latency_ms는 check() 전체 실행 시간을 `performance.now()`로 계측한다.

import type { Quest } from "../schemas/quest.js";
import type { SafetyCategory, SafetyRules } from "./schemas.js";

export interface RuleFilterResult {
  verdict: "pass" | "replaced" | "block_and_fallback";
  matches: string[];
  replacedQuest?: Quest;
  latency_ms: number;
  category?: string;
}

export class RuleFilter {
  // 정규식은 생성자에서 한 번만 컴파일해 재사용한다. loadSafetyRules가 이미
  // 로딩 시점에 컴파일 유효성을 검증하므로 여기서는 안전하게 생성 가능.
  private readonly compiledPatterns: Map<string, RegExp[]>;
  // allowlist는 긴 항목부터 제거해야 상위 문자열이 하위에 먹히는 것을 방지한다.
  private readonly sortedAllowlist: string[];

  constructor(private readonly rules: SafetyRules) {
    this.compiledPatterns = new Map();
    for (const [name, category] of Object.entries(rules.categories)) {
      const patterns = category.patterns ?? [];
      this.compiledPatterns.set(
        name,
        patterns.map((p) => new RegExp(p)),
      );
    }

    this.sortedAllowlist = [...rules.allowlist].sort(
      (a, b) => b.length - a.length,
    );
  }

  check(quest: Quest): RuleFilterResult {
    const t0 = performance.now();

    const scanText = `${quest.quest_name}\n${quest.description}`;
    const strippedText = this.stripAllowlist(scanText);

    // Phase 1: block_and_fallback 카테고리 1차 검사
    const firstBlockHit = this.findBlockHit(strippedText);
    if (firstBlockHit !== null) {
      return {
        verdict: "block_and_fallback",
        category: firstBlockHit.category,
        matches: firstBlockHit.matches,
        latency_ms: performance.now() - t0,
      };
    }

    // Phase 2: replace 카테고리 적용 (description만 치환)
    const replaceOutcome = this.applyReplacements(quest.description, strippedText);

    if (replaceOutcome.matches.length === 0) {
      // 어떤 룰도 히트하지 않음 → pass
      return {
        verdict: "pass",
        matches: [],
        latency_ms: performance.now() - t0,
      };
    }

    // Phase 3: 치환된 텍스트로 block 재검사
    const replacedScanText = `${quest.quest_name}\n${replaceOutcome.replacedDescription}`;
    const strippedReplaced = this.stripAllowlist(replacedScanText);
    const secondBlockHit = this.findBlockHit(strippedReplaced);

    if (secondBlockHit !== null) {
      return {
        verdict: "block_and_fallback",
        category: secondBlockHit.category,
        matches: secondBlockHit.matches,
        latency_ms: performance.now() - t0,
      };
    }

    // 치환만 일어나고 잔여 차단 키워드 없음 → replaced
    const replacedQuest: Quest = {
      ...quest,
      description: replaceOutcome.replacedDescription,
    };

    return {
      verdict: "replaced",
      matches: replaceOutcome.matches,
      replacedQuest,
      latency_ms: performance.now() - t0,
    };
  }

  // allowlist 항목을 길이 내림차순으로 제거해 매칭 대상에서 제외한다.
  private stripAllowlist(text: string): string {
    let stripped = text;
    for (const item of this.sortedAllowlist) {
      if (item.length === 0) continue;
      stripped = stripped.split(item).join("");
    }
    return stripped;
  }

  // block_and_fallback 카테고리에서 첫 번째 히트를 찾아 반환. 없으면 null.
  private findBlockHit(
    text: string,
  ): { category: string; matches: string[] } | null {
    for (const [name, category] of Object.entries(this.rules.categories)) {
      if (category.action !== "block_and_fallback") continue;

      const matches = this.matchCategory(name, category, text);
      if (matches.length > 0) {
        return { category: name, matches };
      }
    }
    return null;
  }

  // replace 카테고리를 순회하며 description에 치환을 누적 적용.
  // 검사는 strippedScanText 기준으로 수행하고, 실제 치환은 원본 description에 대해 수행.
  private applyReplacements(
    description: string,
    strippedScanText: string,
  ): { replacedDescription: string; matches: string[] } {
    let replacedDescription = description;
    const matches: string[] = [];

    for (const [, category] of Object.entries(this.rules.categories)) {
      if (category.action !== "replace") continue;

      for (const keyword of category.keywords) {
        if (keyword.length === 0) continue;
        if (!strippedScanText.includes(keyword)) continue;

        const replacement = category.replacements[keyword] ?? "";
        replacedDescription = replacedDescription.split(keyword).join(replacement);
        matches.push(keyword);
      }
      // replace 카테고리의 patterns는 현재 스펙상 치환 매핑이 정의되지 않으므로
      // 처리하지 않는다. 필요해지는 시점에 테스트와 함께 추가한다.
    }

    return { replacedDescription, matches };
  }

  // 단일 카테고리에 대해 키워드 + 정규식 히트를 수집한다.
  private matchCategory(
    name: string,
    category: SafetyCategory,
    text: string,
  ): string[] {
    const hits: string[] = [];

    for (const keyword of category.keywords) {
      if (keyword.length === 0) continue;
      if (text.includes(keyword)) {
        hits.push(keyword);
      }
    }

    const patterns = this.compiledPatterns.get(name) ?? [];
    for (const regex of patterns) {
      const m = text.match(regex);
      if (m !== null) {
        hits.push(m[0]);
      }
    }

    return hits;
  }
}
