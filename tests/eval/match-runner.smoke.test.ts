// F-002 Task 9 — 매칭 평가 러너 스모크 테스트.
//
// 설계:
// - QuestRetriever 자체를 DI로 교체해 네트워크/벡터 DB 호출을 모두 차단한다.
//   `runMatchEval(options, deps)` 의 `deps.retriever` 주입점을 사용.
// - 3건짜리 입력(vector_exact 1 / vector_modify 1 / llm_new 1)으로
//   경로 카운트, vectorHitRate, intentPreservationRate 산출 정확도 검증.
// - 출력 파일은 os.tmpdir() 하위에 기록하고 afterAll에서 정리한다.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestRetriever } from "../../src/core/retriever.js";
import type { Quest } from "../../src/core/schemas/quest.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const EXACT_QUEST: Quest = {
  quest_name: "빛의 양치 의식",
  description: "하루의 시작과 끝, 빛의 기사답게 이를 깨끗이 닦는다.",
  category: "위생",
  stat_mapping: { 체력: 2 },
  reward: { exp: 20, coin: 5 },
  suggested_grade: "D",
  mandatory_suitability: "high",
  original_habit: "양치하기",
  worldview_id: "kingdom_of_light",
};

const MODIFY_QUEST: Quest = {
  ...EXACT_QUEST,
  quest_name: "빛의 손 씻기 의식",
  description: "손에 묻은 먼지를 씻어내고 빛의 기운을 불러들인다.",
  original_habit: "손씻기",
};

const NEW_QUEST: Quest = {
  ...EXACT_QUEST,
  quest_name: "새벽 독서 탐험",
  description: "아침 햇살 아래 책장을 넘기며 지혜를 쌓는다.",
  category: "학습",
  original_habit: "책 읽기",
};

interface SimilarHabit {
  id: string;
  text: string;
  expectedHabitCategory: string;
  originalId: string | null;
}

const MOCK_HABITS: SimilarHabit[] = [
  // 1) vector_exact 경로 — category가 expectedHabitCategory와 일치 → intentPreserved=true
  {
    id: "s001",
    text: "자기 전에 이를 닦자",
    expectedHabitCategory: "위생",
    originalId: "h001",
  },
  // 2) vector_modify 경로
  {
    id: "s002",
    text: "손을 깨끗이 씻는다",
    expectedHabitCategory: "위생",
    originalId: "h002",
  },
  // 3) llm_new 경로
  {
    id: "s003",
    text: "매일 책 한 권 읽기",
    expectedHabitCategory: "학습",
    originalId: "h012",
  },
];

// -----------------------------------------------------------------------------
// Temp output directory
// -----------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), "match-runner-smoke-"));

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// -----------------------------------------------------------------------------
// Retriever fake builder
// -----------------------------------------------------------------------------

interface RetrieveResponse {
  quest: Quest;
  meta: {
    path: "vector_exact" | "vector_modify" | "llm_new";
    similarity: number | null;
    latency_ms: number;
  };
}

function buildFakeRetriever(responses: RetrieveResponse[]): QuestRetriever {
  const queue = [...responses];
  const retrieve = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fake retriever: 응답이 모두 소진되었습니다");
    return next;
  });
  return { retrieve } as unknown as QuestRetriever;
}

// -----------------------------------------------------------------------------
// Helper: write MOCK_HABITS to a temp JSON file
// -----------------------------------------------------------------------------

function writeHabitsFile(path: string, habits: SimilarHabit[]): void {
  writeFileSync(path, JSON.stringify(habits, null, 2), "utf-8");
}

// 동적 import — 필요 시 모듈 측 최상위 바인딩을 이 파일의 vi.mock 이후로 미룰 수 있음.
async function importMatchRunner() {
  return await import("../../src/eval/match-runner.js");
}

describe("runMatchEval 스모크", () => {
  let inputPath: string;

  beforeEach(() => {
    inputPath = join(tmpRoot, "habits-3.json");
    writeHabitsFile(inputPath, MOCK_HABITS);
  });

  it("3건 입력(exact/modify/new) → 경로 카운트와 matchRate/intentPreservationRate 산출", async () => {
    const responses: RetrieveResponse[] = [
      {
        quest: EXACT_QUEST, // category="위생"
        meta: { path: "vector_exact", similarity: 0.92, latency_ms: 120 },
      },
      {
        quest: MODIFY_QUEST,
        meta: { path: "vector_modify", similarity: 0.8, latency_ms: 800 },
      },
      {
        quest: NEW_QUEST,
        meta: { path: "llm_new", similarity: null, latency_ms: 1800 },
      },
    ];

    const outputPath = join(tmpRoot, "run-basic.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: inputPath,
        worldviews: ["kingdom_of_light"],
        thresholds: [0.9],
        output: outputPath,
      },
      { retriever: buildFakeRetriever(responses) },
    );

    // 파일 기록 확인
    expect(existsSync(outputPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(outputPath, "utf-8"));

    for (const obj of [result, persisted]) {
      expect(typeof obj.runId).toBe("string");
      expect(typeof obj.startedAt).toBe("string");
      expect(typeof obj.completedAt).toBe("string");
      expect(Array.isArray(obj.thresholds)).toBe(true);
      expect(obj.thresholds).toHaveLength(1);
    }

    const block = result.thresholds[0];
    expect(block.exact).toBe(0.9);
    expect(block.modify).toBeCloseTo(0.7, 6);

    // items
    expect(block.items).toHaveLength(3);
    expect(block.items[0].path).toBe("vector_exact");
    expect(block.items[0].similarity).toBe(0.92);
    expect(block.items[0].intentPreserved).toBe(true);
    expect(block.items[1].path).toBe("vector_modify");
    expect(block.items[1].intentPreserved).toBeNull();
    expect(block.items[2].path).toBe("llm_new");
    expect(block.items[2].similarity).toBeNull();
    expect(block.items[2].intentPreserved).toBeNull();

    // summary
    const s = block.summary;
    expect(s.total).toBe(3);
    expect(s.failed).toBe(0);
    expect(s.vectorExact).toBe(1);
    expect(s.vectorModify).toBe(1);
    expect(s.llmNew).toBe(1);
    expect(s.vectorHitRate).toBeCloseTo(2 / 3, 6);
    expect(s.intentPreservationRate).toBe(1.0);
    expect(s.avgLatencyMs).toBeCloseTo((120 + 800 + 1800) / 3, 6);
    // avgLatencyExactMs: vector_exact 경로(latency=120ms) 단독 평균 — G-2 기준
    expect(s.avgLatencyExactMs).toBeCloseTo(120, 6);
    expect(typeof s.p95LatencyMs).toBe("number");
  });

  it("vector_exact 경로에서 category 불일치면 intentPreserved=false", async () => {
    // EXACT_QUEST.category = "위생" 인데 expectedHabitCategory = "학습" → 불일치.
    const mismatchedHabits: SimilarHabit[] = [
      {
        id: "sMISS",
        text: "무언가",
        expectedHabitCategory: "학습", // 퀘스트 category("위생")와 다름
        originalId: "h001",
      },
    ];
    const mismatchedPath = join(tmpRoot, "habits-mismatch.json");
    writeHabitsFile(mismatchedPath, mismatchedHabits);

    const responses: RetrieveResponse[] = [
      {
        quest: EXACT_QUEST, // category="위생"
        meta: { path: "vector_exact", similarity: 0.95, latency_ms: 100 },
      },
    ];

    const outputPath = join(tmpRoot, "run-mismatch.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: mismatchedPath,
        worldviews: ["kingdom_of_light"],
        thresholds: [0.9],
        output: outputPath,
      },
      { retriever: buildFakeRetriever(responses) },
    );

    const block = result.thresholds[0];
    expect(block.items[0].intentPreserved).toBe(false);
    expect(block.summary.vectorExact).toBe(1);
    expect(block.summary.intentPreservationRate).toBe(0);
  });

  it("retriever.retrieve가 실패하면 failed로 기록하고 지표에서 제외", async () => {
    const failingRetriever = {
      retrieve: vi.fn(async () => {
        throw new Error("simulated failure");
      }),
    } as unknown as QuestRetriever;

    // 1건짜리 입력
    const onePath = join(tmpRoot, "habits-fail.json");
    writeHabitsFile(onePath, MOCK_HABITS.slice(0, 1));

    const outputPath = join(tmpRoot, "run-fail.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: onePath,
        worldviews: ["kingdom_of_light"],
        thresholds: [0.9],
        output: outputPath,
      },
      { retriever: failingRetriever },
    );

    const block = result.thresholds[0];
    expect(block.items).toHaveLength(1);
    const item = block.items[0];
    expect(item.path).toBeNull();
    expect(item.latencyMs).toBeNull();
    expect(item.intentPreserved).toBeNull();
    expect(typeof item.error).toBe("string");
    expect((item.error ?? "").length).toBeGreaterThan(0);

    const s = block.summary;
    expect(s.failed).toBe(1);
    // total(= 성공한 items)이 0이면 vectorHitRate과 avgLatencyMs는 0, intentPreservationRate는 null.
    expect(s.total).toBe(0);
    expect(s.vectorExact).toBe(0);
    expect(s.vectorModify).toBe(0);
    expect(s.llmNew).toBe(0);
    expect(s.vectorHitRate).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
    expect(s.avgLatencyExactMs).toBeNull();
    expect(s.intentPreservationRate).toBeNull();
  });

  it("vectorExact=0일 때 intentPreservationRate는 null", async () => {
    const responses: RetrieveResponse[] = [
      {
        quest: MODIFY_QUEST,
        meta: { path: "vector_modify", similarity: 0.8, latency_ms: 500 },
      },
      {
        quest: NEW_QUEST,
        meta: { path: "llm_new", similarity: null, latency_ms: 1600 },
      },
    ];

    // 2건짜리 입력 파일 새로 작성
    const twoPath = join(tmpRoot, "habits-2.json");
    writeHabitsFile(twoPath, MOCK_HABITS.slice(1));

    const outputPath = join(tmpRoot, "run-no-exact.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: twoPath,
        worldviews: ["kingdom_of_light"],
        thresholds: [0.9],
        output: outputPath,
      },
      { retriever: buildFakeRetriever(responses) },
    );

    const s = result.thresholds[0].summary;
    expect(s.vectorExact).toBe(0);
    expect(s.intentPreservationRate).toBeNull();
  });

  it("parseArgs: --thresholds 파싱 + 기본값 확인", async () => {
    const { parseArgs } = await importMatchRunner();
    const opts = parseArgs([
      "--input=/tmp/x.json",
      "--worldview=kingdom_of_light",
      "--thresholds=0.7,0.8,0.9",
      "--output=/tmp/out.json",
    ]);
    expect(opts.input).toBe("/tmp/x.json");
    expect(opts.worldviews).toEqual(["kingdom_of_light"]);
    expect(opts.thresholds).toEqual([0.7, 0.8, 0.9]);
    expect(opts.output).toBe("/tmp/out.json");
  });

  it("parseArgs: 기본값 — worldview=all, 기본 thresholds", async () => {
    const { parseArgs } = await importMatchRunner();
    const opts = parseArgs([]);
    expect(opts.worldviews).toEqual(["kingdom_of_light", "starlight_magic_school"]);
    expect(opts.thresholds.length).toBeGreaterThan(0);
    expect(opts.input).toMatch(/similar-100\.json$/);
  });

  it("parseArgs: --thresholds 잘못된 값(비숫자)은 거부한다", async () => {
    const { parseArgs } = await importMatchRunner();
    expect(() => parseArgs(["--thresholds=abc"])).toThrow();
  });

  it("parseArgs: --thresholds 범위(0,1] 밖이면 거부한다", async () => {
    const { parseArgs } = await importMatchRunner();
    // 0.2 이하면 modify = exact - 0.2 가 0 이하 → 불가.
    expect(() => parseArgs(["--thresholds=0.1"])).toThrow();
    expect(() => parseArgs(["--thresholds=1.5"])).toThrow();
  });

  it("worldview=all이면 habits × worldviews 만큼 items를 생성한다", async () => {
    // 2개 habit × 2개 worldview = 4건 호출 예상
    const twoPath = join(tmpRoot, "habits-two.json");
    writeHabitsFile(twoPath, MOCK_HABITS.slice(0, 2));

    const responses: RetrieveResponse[] = Array.from({ length: 4 }, () => ({
      quest: EXACT_QUEST,
      meta: {
        path: "vector_exact" as const,
        similarity: 0.95,
        latency_ms: 100,
      },
    }));

    const outputPath = join(tmpRoot, "run-all-wv.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: twoPath,
        worldviews: ["kingdom_of_light", "starlight_magic_school"],
        thresholds: [0.9],
        output: outputPath,
      },
      { retriever: buildFakeRetriever(responses) },
    );

    expect(result.thresholds[0].items).toHaveLength(4);
    const wvIds = new Set(result.thresholds[0].items.map((i) => i.worldviewId));
    expect(wvIds.has("kingdom_of_light")).toBe(true);
    expect(wvIds.has("starlight_magic_school")).toBe(true);
  });

  it("thresholds 배열이 여러 개면 블록 수도 동일", async () => {
    // 3개 habit × 1 worldview × 2 thresholds = 6 호출
    const responses: RetrieveResponse[] = Array.from({ length: 6 }, () => ({
      quest: EXACT_QUEST,
      meta: {
        path: "vector_exact" as const,
        similarity: 0.93,
        latency_ms: 100,
      },
    }));

    const outputPath = join(tmpRoot, "run-two-thresh.json");
    const { runMatchEval } = await importMatchRunner();

    const result = await runMatchEval(
      {
        input: inputPath,
        worldviews: ["kingdom_of_light"],
        thresholds: [0.8, 0.9],
        output: outputPath,
      },
      { retriever: buildFakeRetriever(responses) },
    );

    expect(result.thresholds).toHaveLength(2);
    expect(result.thresholds[0].exact).toBe(0.8);
    expect(result.thresholds[0].modify).toBeCloseTo(0.6, 6);
    expect(result.thresholds[1].exact).toBe(0.9);
    expect(result.thresholds[1].modify).toBeCloseTo(0.7, 6);
    expect(result.thresholds[0].items).toHaveLength(3);
    expect(result.thresholds[1].items).toHaveLength(3);
  });
});
