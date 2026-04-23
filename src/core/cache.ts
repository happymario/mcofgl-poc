// F-004 Task 4 — Redis 기반 Quest 변환 결과 캐시.
//
// - 키: habit_text + worldview_id + age_group + character_context MD5 해시 (32자 hex).
//   character_context를 포함해 캐릭터 컨텍스트가 다른 요청 간의 cross-context 오염을 방지한다.
// - TTL: 24시간(86400초) 기본값.
// - 실패 정책: Redis 연결/명령 오류는 조용히 스킵한다.
//   · get → null (MISS로 취급)
//   · set → resolve + console.warn (저장 실패가 요청 흐름을 막지 않는다)
//
// 주의: 키 조립은 `:` 구분자로 단순 연결한다. 입력 필드에 `:`가 섞이면
// 이론상 충돌 가능하나, worldview_id([a-z0-9_-])와 age_group(\d-\d) 제약으로
// 실질 충돌 가능성은 없다.

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { QuestSchema } from "./schemas/quest.js";
import type { Quest } from "./schemas/quest.js";

export function buildCacheKey(params: {
  habit_text: string;
  worldview_id: string;
  age_group: string;
  character_context?: { name: string; class: string; level: number };
}): string {
  // character_context가 있으면 JSON으로 직렬화해 키에 포함한다.
  // 없을 때는 빈 문자열로 처리해 하위 호환을 유지한다.
  const ctxStr = params.character_context
    ? JSON.stringify(params.character_context)
    : "";
  return createHash("md5")
    .update(`${params.habit_text}:${params.worldview_id}:${params.age_group}:${ctxStr}`)
    .digest("hex");
}

export class RedisCache {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<Quest | null> {
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      const result = QuestSchema.safeParse(parsed);
      // 스키마 위반(캐시 포이즈닝 방어) → MISS로 취급.
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  async set(key: string, quest: Quest, ttlSeconds = 86400): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(quest), "EX", ttlSeconds);
    } catch (cause) {
      console.warn("[RedisCache] set 실패 (무시):", cause);
    }
  }
}
