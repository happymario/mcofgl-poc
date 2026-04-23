// F-004 Task 4 — Redis 기반 Quest 변환 결과 캐시.
//
// - 키: habit_text + worldview_id + age_group MD5 해시 (32자 hex).
// - TTL: 24시간(86400초) 기본값.
// - 실패 정책: Redis 연결/명령 오류는 조용히 스킵한다.
//   · get → null (MISS로 취급)
//   · set → resolve + console.warn (저장 실패가 요청 흐름을 막지 않는다)
//
// 주의: 키 조립은 `:` 구분자로 단순 연결한다. 입력 필드에 `:`가 섞이면
// 이론상 충돌 가능하나, PoC 단계에선 허용 범위로 간주한다.

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { QuestSchema } from "./schemas/quest.js";
import type { Quest } from "./schemas/quest.js";

export function buildCacheKey(params: {
  habit_text: string;
  worldview_id: string;
  age_group: string;
}): string {
  return createHash("md5")
    .update(`${params.habit_text}:${params.worldview_id}:${params.age_group}`)
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
