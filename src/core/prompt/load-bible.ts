// 스펙 §3.2 — 세계관 바이블 JSON 로더.
//
// 역할:
// - `<baseDir>/data/worldviews/<worldviewId>.json`을 읽어 들인다.
// - `WorldviewBibleSchema`로 검증해 타입 안전한 객체를 반환한다.
// - 동일 ID 반복 호출 시 Map 캐시로 같은 참조를 재사용해 I/O를 제거한다.
// - 파일 부재 / JSON 파싱 실패 / 스키마 위반은 모두 `Error` throw.
//
// baseDir 기본값은 process.cwd(). 테스트는 임시 디렉터리를 직접 주입한다.
// (process.chdir 전역 상태 변경을 피하기 위한 의존성 주입 패턴)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type WorldviewBible,
  WorldviewBibleSchema,
} from "../schemas/worldview.js";

const cache = new Map<string, WorldviewBible>();

export function loadBible(worldviewId: string, baseDir?: string): WorldviewBible {
  const cached = cache.get(worldviewId);
  if (cached !== undefined) {
    return cached;
  }

  const root = baseDir ?? process.cwd();
  const filePath = join(root, "data", "worldviews", `${worldviewId}.json`);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (cause) {
    throw new Error(
      `세계관 바이블을 찾을 수 없습니다: ${worldviewId}`,
      { cause },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`세계관 바이블 JSON 파싱 실패: ${worldviewId}`, { cause });
  }

  const parsed = WorldviewBibleSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `세계관 바이블 스키마 검증 실패: ${worldviewId} - ${parsed.error.message}`,
    );
  }

  cache.set(worldviewId, parsed.data);
  return parsed.data;
}

export function clearBibleCache(): void {
  cache.clear();
}
