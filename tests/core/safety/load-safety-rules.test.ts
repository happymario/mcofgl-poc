// loadSafetyRules 파일 I/O + 캐싱 + 정규식 컴파일 계약 테스트.
//
// - 성공 케이스: `data/safety-rules.json`을 SafetyRulesSchema로 파싱해 반환.
// - 실패 케이스: action enum 위반 → 스키마 에러 / 잘못된 정규식 → 명시적 에러.
// - 캐시: 동일 baseDir로 두 번 호출하면 같은 참조를 반환.
//
// process.chdir 전역 변경 대신 baseDir 파라미터로 임시 디렉터리를 주입한다.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSafetyRulesCache,
  loadSafetyRules,
} from "../../../src/core/safety/load-safety-rules.js";

describe("loadSafetyRules — 실제 data/safety-rules.json", () => {
  beforeEach(() => {
    clearSafetyRulesCache();
  });

  afterEach(() => {
    clearSafetyRulesCache();
  });

  it("유효한 JSON을 로드해 SafetyRules 객체를 반환한다", () => {
    const rules = loadSafetyRules();
    expect(rules.categories).toBeDefined();
    expect(Object.keys(rules.categories).length).toBeGreaterThan(0);
    expect(Array.isArray(rules.allowlist)).toBe(true);
    // 스펙에 명시된 핵심 카테고리 존재 확인
    expect(rules.categories.violence).toBeDefined();
    expect(rules.categories.violence.action).toBe("block_and_fallback");
  });
});

describe("loadSafetyRules — baseDir 주입 기반 검증", () => {
  let tempRoot: string;

  beforeEach(() => {
    clearSafetyRulesCache();
    tempRoot = mkdtempSync(join(tmpdir(), "safety-rules-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    clearSafetyRulesCache();
  });

  function writeRulesFile(content: unknown): void {
    const dir = join(tempRoot, "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "safety-rules.json"),
      JSON.stringify(content),
      "utf-8",
    );
  }

  it("action enum이 잘못되면 스키마 에러를 throw한다", () => {
    writeRulesFile({
      categories: {
        bad: {
          keywords: ["foo"],
          action: "invalid",
        },
      },
      allowlist: [],
    });
    expect(() => loadSafetyRules(tempRoot)).toThrow(/스키마 검증 실패/);
  });

  it("patterns에 잘못된 정규식이 포함되면 명시적 에러를 throw한다", () => {
    writeRulesFile({
      categories: {
        violence: {
          keywords: ["살인"],
          patterns: ["[invalid"],
          action: "block_and_fallback",
        },
      },
      allowlist: [],
    });
    expect(() => loadSafetyRules(tempRoot)).toThrow(/정규식/);
  });

  it("action=replace인데 replacements가 없으면 스키마 에러를 throw한다", () => {
    writeRulesFile({
      categories: {
        bad: {
          keywords: ["foo"],
          action: "replace",
          // replacements 누락 — discriminated union 위반
        },
      },
      allowlist: [],
    });
    expect(() => loadSafetyRules(tempRoot)).toThrow(/스키마 검증 실패/);
  });

  it("같은 baseDir로 반복 호출하면 동일 참조(캐시)를 반환한다", () => {
    writeRulesFile({
      categories: {
        violence: {
          keywords: ["살인"],
          action: "block_and_fallback",
        },
      },
      allowlist: ["용사"],
    });
    const first = loadSafetyRules(tempRoot);
    const second = loadSafetyRules(tempRoot);
    expect(first).toBe(second);
  });
});
