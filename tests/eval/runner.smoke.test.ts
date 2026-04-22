// F-001 Task 10 — 평가 러너 스모크 테스트.
//
// 네트워크/파일시스템 오염을 막기 위해:
// - Anthropic SDK 전체를 vi.mock으로 교체 (실제 API 호출 차단)
// - loadBible은 번들된 data/worldviews/* 파일을 읽도록 실제 구현을 사용해도 되나,
//   테스트 결정성을 높이기 위해 바이블도 인라인 스텁으로 주입한다.
// - 출력 파일은 os.tmpdir() 하위에 기록하고 afterAll에서 정리한다.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quest } from "../../src/core/schemas/quest.js";
import type { WorldviewBible } from "../../src/core/schemas/worldview.js";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

const LIGHT_BIBLE: WorldviewBible = {
  id: "kingdom_of_light",
  background: "빛의 왕국 배경 (스텁)",
  tone: {
    keywords: ["용사", "빛", "결의"],
    forbidden: ["기숙사", "수업", "교수"],
    examples: ["용사여 나아가라"],
  },
  vocabulary: { 집: "길드 기지" },
  npcs: [
    { name: "레오나르트", role: "길드 마스터", personality: "엄격", speech_style: "반말" },
  ],
  few_shots: [],
};

const STARLIGHT_BIBLE: WorldviewBible = {
  id: "starlight_magic_school",
  background: "별빛 마법학교 배경 (스텁)",
  tone: {
    keywords: ["배움", "마법", "우정"],
    forbidden: ["용사", "여명", "기사"],
    examples: ["오늘도 별빛이 반짝이네"],
  },
  vocabulary: { 집: "별빛 기숙사" },
  npcs: [
    { name: "아르테", role: "사감 선생님", personality: "다정", speech_style: "존대" },
  ],
  few_shots: [],
};

vi.mock("../../src/core/prompt/load-bible.js", () => ({
  loadBible: vi.fn((id: string) => {
    if (id === "kingdom_of_light") return LIGHT_BIBLE;
    if (id === "starlight_magic_school") return STARLIGHT_BIBLE;
    throw new Error(`알 수 없는 worldview_id: ${id}`);
  }),
  clearBibleCache: vi.fn(),
}));

const VALID_QUEST_FIXTURE: Quest = {
  quest_name: "빛의 서약 실행",
  description: "여명의 시간에 일어나 결의를 다진다.",
  category: "기상/취침",
  stat_mapping: { 체력: 2, 근성: 1 },
  reward: { exp: 30, coin: 10, buff: "새벽의 가호" },
  suggested_grade: "C",
  mandatory_suitability: "high",
  original_habit: "placeholder",
  worldview_id: "placeholder",
};

function buildAnthropicResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// 테스트용 출력 디렉터리 — 리포지토리 트리에 파일을 만들지 않는다.
const tmpRoot = mkdtempSync(join(tmpdir(), "eval-runner-smoke-"));

afterAll(() => {
  // 성공/실패 여부와 무관하게 정리한다.
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// 동적 import — vi.mock 이후 모듈을 로드한다.
async function importRunner() {
  return await import("../../src/eval/runner.js");
}

describe("runEvaluation 스모크", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("--limit=1 --worldview=kingdom_of_light로 정상 종료하고 파일을 남긴다", async () => {
    mockCreate.mockResolvedValue(
      buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)),
    );
    const outputPath = join(tmpRoot, "run-ok.json");

    const { runEvaluation } = await importRunner();
    const result = await runEvaluation({
      model: "claude-test",
      worldviews: ["kingdom_of_light"],
      output: outputPath,
      limit: 1,
    });

    expect(existsSync(outputPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(outputPath, "utf-8"));

    // 출력 스키마 필드 확인
    for (const obj of [result, persisted]) {
      expect(typeof obj.runId).toBe("string");
      expect(obj.model).toBe("claude-test");
      expect(Array.isArray(obj.worldviews)).toBe(true);
      expect(obj.worldviews).toEqual(["kingdom_of_light"]);
      expect(typeof obj.startedAt).toBe("string");
      expect(typeof obj.completedAt).toBe("string");
      expect(Array.isArray(obj.items)).toBe(true);
      expect(obj.summary).toBeDefined();
    }

    // items 길이 = limit × worldview 수
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.habitId).toBe("h001");
    expect(item.worldviewId).toBe("kingdom_of_light");
    expect(item.quest).not.toBeNull();
    expect(item.meta).not.toBeNull();
    expect(item.checks).toBeDefined();
    expect(Array.isArray(item.checks.forbiddenMatches)).toBe(true);
    expect(Array.isArray(item.checks.crossContamination)).toBe(true);

    // summary
    expect(result.summary.total).toBe(1);
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.totalPromptTokens).toBe(100);
    expect(result.summary.totalCompletionTokens).toBe(50);
  });

  it("두 세계관 모두 --limit=1이면 items는 정확히 2건이다", async () => {
    mockCreate.mockResolvedValue(
      buildAnthropicResponse(JSON.stringify(VALID_QUEST_FIXTURE)),
    );
    const outputPath = join(tmpRoot, "run-two.json");

    const { runEvaluation } = await importRunner();
    const result = await runEvaluation({
      model: "claude-test",
      worldviews: ["kingdom_of_light", "starlight_magic_school"],
      output: outputPath,
      limit: 1,
    });

    expect(result.items).toHaveLength(2);
    const ids = new Set(result.items.map((i) => i.worldviewId));
    expect(ids.has("kingdom_of_light")).toBe(true);
    expect(ids.has("starlight_magic_school")).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
  });

  it("API가 항상 실패하면 해당 항목은 quest=null, error 필드가 채워진다", async () => {
    mockCreate.mockRejectedValue(new Error("network down"));
    const outputPath = join(tmpRoot, "run-fail.json");

    const { runEvaluation } = await importRunner();
    const result = await runEvaluation({
      model: "claude-test",
      worldviews: ["kingdom_of_light"],
      output: outputPath,
      limit: 1,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.quest).toBeNull();
    expect(item.meta).toBeNull();
    expect(typeof item.error).toBe("string");
    expect(item.error?.length).toBeGreaterThan(0);
    expect(result.summary.succeeded).toBe(0);
    expect(result.summary.failed).toBe(1);
    // 실패만 존재하면 평균/분위는 0으로 안전하게 채워진다.
    expect(result.summary.avgLatencyMs).toBe(0);
    expect(result.summary.p95LatencyMs).toBe(0);
  });

  it("parseArgs: --model=sonnet, --limit=3, --worldview=kingdom_of_light 파싱", async () => {
    const { parseArgs } = await importRunner();
    const opts = parseArgs([
      "--model=sonnet",
      "--worldview=kingdom_of_light",
      "--limit=3",
      "--output=/tmp/x.json",
    ]);
    expect(opts.model).toBe("sonnet");
    expect(opts.worldviews).toEqual(["kingdom_of_light"]);
    expect(opts.limit).toBe(3);
    expect(opts.output).toBe("/tmp/x.json");
  });

  it("parseArgs: 기본값 — 모든 세계관, limit=0, haiku 모델", async () => {
    const { parseArgs } = await importRunner();
    const opts = parseArgs([]);
    expect(opts.model).toBe("haiku");
    expect(opts.worldviews).toEqual([
      "kingdom_of_light",
      "starlight_magic_school",
    ]);
    expect(opts.limit).toBe(0);
    expect(typeof opts.output).toBe("string");
    expect(opts.output).toMatch(/data\/evaluations\/run-.+\.json$/);
  });

  it("parseArgs: --worldview=all은 기본 두 세계관을 반환", async () => {
    const { parseArgs } = await importRunner();
    const opts = parseArgs(["--worldview=all"]);
    expect(opts.worldviews).toEqual([
      "kingdom_of_light",
      "starlight_magic_school",
    ]);
  });
});
