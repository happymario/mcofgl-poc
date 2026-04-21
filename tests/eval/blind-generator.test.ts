// F-001 Task 11 — 블라인드 평가 아티팩트 생성기 테스트.
//
// 목적:
// - Task 10 runEvaluation 결과 JSON을 입력으로 받아
//   · 두 세계관 모두에서 성공(quest != null)한 habitId만 추출
//   · 세계관별로 항목을 만들어 무작위 섞기
//   · worldview_id 라벨이 없는 CSV + 정답 JSON 산출
// 을 검증한다.
//
// 테스트는 순서 비의존적으로 작성한다 (무작위 섞기를 seed로 고정하지 않는다).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 테스트 픽스처: runEvaluation 결과 JSON과 동일 스키마의 최소 객체.
// 불필요한 필드(meta/checks 상세값 등)는 가장 단순한 형태로 채운다.
interface FixtureItem {
  habitId: string;
  habitText: string;
  worldviewId: string;
  quest:
    | {
        quest_name: string;
        description: string;
        category: string;
        stat_mapping: Record<string, number>;
        reward: { exp: number; coin: number; buff: string };
        suggested_grade: string;
        mandatory_suitability: string;
        original_habit: string;
        worldview_id: string;
      }
    | null;
  meta: null | { latency_ms: number; prompt_tokens: number; completion_tokens: number };
  checks: {
    forbiddenHit: boolean;
    forbiddenMatches: string[];
    crossContamination: string[];
  };
  error?: string;
}

function makeQuest(overrides: Partial<{ quest_name: string; description: string }>) {
  return {
    quest_name: overrides.quest_name ?? "기본 퀘스트",
    description: overrides.description ?? "기본 설명",
    category: "생활/기타",
    stat_mapping: { 체력: 1 },
    reward: { exp: 10, coin: 5, buff: "미약한 활력" },
    suggested_grade: "C",
    mandatory_suitability: "medium",
    original_habit: "placeholder",
    worldview_id: "placeholder",
  };
}

function makeItem(
  habitId: string,
  worldviewId: string,
  succeeded: boolean,
  questOverrides: Partial<{ quest_name: string; description: string }> = {},
): FixtureItem {
  if (succeeded) {
    return {
      habitId,
      habitText: `원본 습관 ${habitId}`,
      worldviewId,
      quest: makeQuest(questOverrides),
      meta: { latency_ms: 100, prompt_tokens: 10, completion_tokens: 10 },
      checks: { forbiddenHit: false, forbiddenMatches: [], crossContamination: [] },
    };
  }
  return {
    habitId,
    habitText: `원본 습관 ${habitId}`,
    worldviewId,
    quest: null,
    meta: null,
    checks: { forbiddenHit: false, forbiddenMatches: [], crossContamination: [] },
    error: "mock failure",
  };
}

function buildRunFixture() {
  const worldviews = ["kingdom_of_light", "starlight_magic_school"];
  const items: FixtureItem[] = [];

  // h001~h005 — 두 세계관 모두 성공
  for (let i = 1; i <= 5; i += 1) {
    const id = `h00${i}`;
    items.push(
      makeItem(id, "kingdom_of_light", true, {
        quest_name: `빛 퀘스트 ${id}`,
        description: `빛 설명 ${id}`,
      }),
    );
    items.push(
      makeItem(id, "starlight_magic_school", true, {
        quest_name: `별빛 퀘스트 ${id}`,
        description: `별빛 설명 ${id}`,
      }),
    );
  }

  // h006 — kingdom_of_light만 성공, starlight_magic_school은 실패
  items.push(
    makeItem("h006", "kingdom_of_light", true, {
      quest_name: "빛 퀘스트 h006",
      description: "빛 설명 h006",
    }),
  );
  items.push(makeItem("h006", "starlight_magic_school", false));

  return {
    runId: "run-fixture",
    model: "claude-test",
    worldviews,
    startedAt: "2026-04-21T00:00:00.000Z",
    completedAt: "2026-04-21T00:00:01.000Z",
    items,
    summary: {
      total: items.length,
      succeeded: items.filter((it) => it.quest !== null).length,
      failed: items.filter((it) => it.quest === null).length,
      avgLatencyMs: 100,
      p95LatencyMs: 100,
      totalPromptTokens: 100,
      totalCompletionTokens: 100,
    },
  };
}

// RFC 4180 규칙에 맞는 최소한의 CSV 파서. 헤더 포함 문자열을 입력받아
// 행 단위 문자열 배열의 배열을 돌려준다.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // 말미 필드/행 flush — 파일이 개행으로 끝나지 않을 수도 있다.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "blind-generator-"));

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("generateBlindArtifacts", () => {
  it("두 세계관 모두 성공한 습관만 선택해 세계관당 1건씩 CSV에 포함한다", async () => {
    const runPath = join(tmpRoot, "run-basic.json");
    const csvPath = join(tmpRoot, "run-basic-blind.csv");
    const answersPath = join(tmpRoot, "run-basic-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    const result = await generateBlindArtifacts({
      runPath,
      outputPath: csvPath,
      answersPath,
    });

    // h001~h005 × 2세계관 = 10건. h006은 제외.
    expect(result.csvRows).toBe(10);
    expect(result.answersCount).toBe(10);
    expect(existsSync(csvPath)).toBe(true);
    expect(existsSync(answersPath)).toBe(true);
  });

  it("CSV에 worldview_id 컬럼이 포함되지 않는다 (헤더 고정)", async () => {
    const runPath = join(tmpRoot, "run-header.json");
    const csvPath = join(tmpRoot, "run-header-blind.csv");
    const answersPath = join(tmpRoot, "run-header-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await generateBlindArtifacts({ runPath, outputPath: csvPath, answersPath });

    const csvText = readFileSync(csvPath, "utf-8");
    const rows = parseCsv(csvText);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual(["itemId", "quest_name", "description"]);
    expect(rows[0]).not.toContain("worldview_id");
  });

  it("answers.json의 itemId와 CSV의 itemId가 1:1 매칭된다", async () => {
    const runPath = join(tmpRoot, "run-match.json");
    const csvPath = join(tmpRoot, "run-match-blind.csv");
    const answersPath = join(tmpRoot, "run-match-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await generateBlindArtifacts({ runPath, outputPath: csvPath, answersPath });

    const csvText = readFileSync(csvPath, "utf-8");
    const rows = parseCsv(csvText);
    // 헤더 제외, itemId 컬럼(0번) 수집
    const csvIds = new Set(rows.slice(1).map((r) => r[0] as string));

    const answers = JSON.parse(readFileSync(answersPath, "utf-8")) as Record<
      string,
      string
    >;
    const answerIds = new Set(Object.keys(answers));

    expect(csvIds.size).toBe(answerIds.size);
    expect(csvIds.size).toBe(10);
    for (const id of csvIds) {
      expect(answerIds.has(id)).toBe(true);
    }
    for (const id of answerIds) {
      expect(csvIds.has(id)).toBe(true);
    }
    // 정답 값은 두 세계관 중 하나여야 한다.
    for (const wv of Object.values(answers)) {
      expect(["kingdom_of_light", "starlight_magic_school"]).toContain(wv);
    }
  });

  it("h006처럼 한 세계관만 성공한 습관은 결과에서 제외된다", async () => {
    const runPath = join(tmpRoot, "run-exclude.json");
    const csvPath = join(tmpRoot, "run-exclude-blind.csv");
    const answersPath = join(tmpRoot, "run-exclude-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await generateBlindArtifacts({ runPath, outputPath: csvPath, answersPath });

    const csvText = readFileSync(csvPath, "utf-8");
    // h006의 quest_name("빛 퀘스트 h006")은 포함되면 안 된다.
    expect(csvText).not.toContain("빛 퀘스트 h006");
    // description도 포함되면 안 된다.
    expect(csvText).not.toContain("빛 설명 h006");
  });

  it("maxHabits로 추출 개수를 제한할 수 있다", async () => {
    const runPath = join(tmpRoot, "run-max.json");
    const csvPath = join(tmpRoot, "run-max-blind.csv");
    const answersPath = join(tmpRoot, "run-max-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    const result = await generateBlindArtifacts({
      runPath,
      outputPath: csvPath,
      answersPath,
      maxHabits: 3,
    });

    // 3개 습관 × 2세계관 = 6
    expect(result.csvRows).toBe(6);
    expect(result.answersCount).toBe(6);
  });

  it("maxHabits<=0은 에러로 거부한다", async () => {
    const runPath = join(tmpRoot, "run-neg.json");
    const csvPath = join(tmpRoot, "run-neg-blind.csv");
    const answersPath = join(tmpRoot, "run-neg-answers.json");
    writeFileSync(runPath, JSON.stringify(buildRunFixture(), null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await expect(
      generateBlindArtifacts({
        runPath,
        outputPath: csvPath,
        answersPath,
        maxHabits: 0,
      }),
    ).rejects.toThrow(/maxHabits/);
  });

  it("입력 JSON에 items 배열이 없으면 에러로 거부한다", async () => {
    const runPath = join(tmpRoot, "run-bad.json");
    const csvPath = join(tmpRoot, "run-bad-blind.csv");
    const answersPath = join(tmpRoot, "run-bad-answers.json");
    writeFileSync(runPath, JSON.stringify({ runId: "x" }), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await expect(
      generateBlindArtifacts({ runPath, outputPath: csvPath, answersPath }),
    ).rejects.toThrow(/items/);
  });

  it("parseCliArgs: --run 필수, 나머지는 선택", async () => {
    const { parseCliArgs } = await import("../../src/eval/blind-generator.js");
    expect(() => parseCliArgs([])).toThrow(/--run/);
    const opts = parseCliArgs([
      "--run=/tmp/a.json",
      "--output=/tmp/b.csv",
      "--answers=/tmp/c.json",
      "--max-habits=5",
    ]);
    expect(opts.runPath).toBe("/tmp/a.json");
    expect(opts.outputPath).toBe("/tmp/b.csv");
    expect(opts.answersPath).toBe("/tmp/c.json");
    expect(opts.maxHabits).toBe(5);
  });

  it("CSV 값 안의 쉼표/줄바꿈/큰따옴표는 RFC 4180 규칙으로 인코딩된다", async () => {
    const run = buildRunFixture();
    // h001/kingdom_of_light 퀘스트 설명에 쉼표/줄바꿈/큰따옴표를 주입한다.
    const target = run.items.find(
      (it) => it.habitId === "h001" && it.worldviewId === "kingdom_of_light",
    );
    if (!target || target.quest === null) {
      throw new Error("fixture precondition failed");
    }
    target.quest.quest_name = '그는 "용사"라 불렸다, 진짜로';
    target.quest.description = "첫 줄\n두 번째 줄";

    const runPath = join(tmpRoot, "run-escape.json");
    const csvPath = join(tmpRoot, "run-escape-blind.csv");
    const answersPath = join(tmpRoot, "run-escape-answers.json");
    writeFileSync(runPath, JSON.stringify(run, null, 2), "utf-8");

    const { generateBlindArtifacts } = await import(
      "../../src/eval/blind-generator.js"
    );
    await generateBlindArtifacts({ runPath, outputPath: csvPath, answersPath });

    const csvText = readFileSync(csvPath, "utf-8");
    const rows = parseCsv(csvText);
    const decoded = rows.slice(1).find((r) => r[1] === '그는 "용사"라 불렸다, 진짜로');
    expect(decoded).toBeDefined();
    expect(decoded?.[2]).toBe("첫 줄\n두 번째 줄");
  });
});
