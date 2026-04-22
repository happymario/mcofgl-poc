// 스펙 §F-003 — Safety 룰 JSON 로더.
//
// 역할:
// - `<baseDir>/data/safety-rules.json`을 읽어 들인다.
// - `SafetyRulesSchema`로 검증해 타입 안전한 객체를 반환한다.
// - patterns에 담긴 정규식 문자열을 실제 `new RegExp(...)`으로 컴파일 검사한다.
//   (런타임에 룰이 실패하지 않도록 로딩 시점에 조기 검출)
// - 동일 baseDir 반복 호출 시 Map 캐시로 같은 참조를 재사용한다.
// - 파일 부재 / JSON 파싱 실패 / 스키마 위반 / 정규식 컴파일 실패는 모두 `Error` throw.
//
// baseDir 기본값은 process.cwd(). 테스트는 임시 디렉터리를 직접 주입한다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SafetyRules, SafetyRulesSchema } from "./schemas.js";

const cache = new Map<string, SafetyRules>();

export function loadSafetyRules(baseDir?: string): SafetyRules {
  const root = baseDir ?? process.cwd();

  const cached = cache.get(root);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = join(root, "data", "safety-rules.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (cause) {
    throw new Error(`Safety 룰 파일을 찾을 수 없습니다: ${filePath}`, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Safety 룰 JSON 파싱 실패: ${filePath}`, { cause });
  }

  const parsed = SafetyRulesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Safety 룰 스키마 검증 실패: ${filePath} - ${parsed.error.message}`,
    );
  }

  // patterns 정규식 컴파일 검증 — 런타임 필터링 전에 조기 실패를 유도한다.
  for (const [categoryName, category] of Object.entries(parsed.data.categories)) {
    if (category.patterns === undefined) continue;
    for (const pattern of category.patterns) {
      try {
        new RegExp(pattern);
      } catch (cause) {
        throw new Error(
          `Safety 룰 정규식 컴파일 실패 (category=${categoryName}, pattern=${pattern})`,
          { cause },
        );
      }
    }
  }

  cache.set(root, parsed.data);
  return parsed.data;
}

export function clearSafetyRulesCache(): void {
  cache.clear();
}
