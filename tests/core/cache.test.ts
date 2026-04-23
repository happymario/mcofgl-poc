// F-004 Task 4 — RedisCache 계약 테스트.
//
// - ioredis 클라이언트는 `vi.fn()`으로 모킹 (네트워크 호출 금지).
// - 캐시 키는 habit_text + worldview_id + age_group MD5 해시로 결정적이다.
// - Redis 오류(get/set)는 조용히 무시 (get → null, set → resolve).
// - 24시간 TTL(86400초)로 Redis에 저장한다.

import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisCache, buildCacheKey } from "../../src/core/cache.js";
import type { Quest } from "../../src/core/schemas/quest.js";

const VALID_QUEST: Quest = {
  quest_name: "빛의 서약 실행",
  description: "아침에 일어나 빛의 서약을 외치고 하루를 시작한다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "아침 7시에 일어나기",
  worldview_id: "kingdom_of_light",
};

function createMockClient() {
  return {
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as Redis & {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
}

describe("buildCacheKey", () => {
  it("동일 입력이면 동일 MD5 해시(32자 hex)를 반환한다", () => {
    const params = {
      habit_text: "아침 7시에 일어나기",
      worldview_id: "kingdom_of_light",
      age_group: "7-12",
    };
    const k1 = buildCacheKey(params);
    const k2 = buildCacheKey(params);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("habit_text가 다르면 키가 달라진다", () => {
    const base = {
      habit_text: "아침 7시에 일어나기",
      worldview_id: "kingdom_of_light",
      age_group: "7-12",
    };
    const other = { ...base, habit_text: "저녁 9시에 자기" };
    expect(buildCacheKey(base)).not.toBe(buildCacheKey(other));
  });

  it("worldview_id가 다르면 키가 달라진다", () => {
    const base = {
      habit_text: "아침 7시에 일어나기",
      worldview_id: "kingdom_of_light",
      age_group: "7-12",
    };
    const other = { ...base, worldview_id: "dark_tower" };
    expect(buildCacheKey(base)).not.toBe(buildCacheKey(other));
  });

  it("age_group이 다르면 키가 달라진다", () => {
    const base = {
      habit_text: "아침 7시에 일어나기",
      worldview_id: "kingdom_of_light",
      age_group: "7-12",
    };
    const other = { ...base, age_group: "13-17" };
    expect(buildCacheKey(base)).not.toBe(buildCacheKey(other));
  });
});

describe("RedisCache", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let cache: RedisCache;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockClient = createMockClient();
    cache = new RedisCache(mockClient);
    // console.warn 출력 억제 + 호출 여부 검증에 사용.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("get", () => {
    it("HIT: 유효 JSON Quest 문자열 → Quest 객체 반환", async () => {
      mockClient.get.mockResolvedValueOnce(JSON.stringify(VALID_QUEST));

      const result = await cache.get("some-key");
      expect(result).toEqual(VALID_QUEST);
      expect(mockClient.get).toHaveBeenCalledWith("some-key");
    });

    it("MISS: client.get이 null을 반환 → null 반환", async () => {
      mockClient.get.mockResolvedValueOnce(null);

      const result = await cache.get("missing-key");
      expect(result).toBeNull();
    });

    it("Redis get 오류 → null 반환 (throw 없음)", async () => {
      mockClient.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await cache.get("some-key");
      expect(result).toBeNull();
    });

    it("JSON 파싱 실패 → null 반환 (throw 없음)", async () => {
      // 캐시에 저장된 값이 손상되었을 때도 조용히 MISS로 처리한다.
      mockClient.get.mockResolvedValueOnce("not json{");

      const result = await cache.get("corrupted-key");
      expect(result).toBeNull();
    });
  });

  describe("set", () => {
    it("성공: client.set을 (key, JSON, 'EX', 86400) 인자로 호출한다", async () => {
      mockClient.set.mockResolvedValueOnce("OK");

      await cache.set("some-key", VALID_QUEST);

      expect(mockClient.set).toHaveBeenCalledTimes(1);
      expect(mockClient.set).toHaveBeenCalledWith(
        "some-key",
        JSON.stringify(VALID_QUEST),
        "EX",
        86400,
      );
    });

    it("커스텀 TTL을 그대로 전달한다", async () => {
      mockClient.set.mockResolvedValueOnce("OK");

      await cache.set("some-key", VALID_QUEST, 60);

      expect(mockClient.set).toHaveBeenCalledWith(
        "some-key",
        JSON.stringify(VALID_QUEST),
        "EX",
        60,
      );
    });

    it("Redis set 오류 → resolve (throw 없음, console.warn 호출)", async () => {
      mockClient.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(cache.set("some-key", VALID_QUEST)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });
  });
});
