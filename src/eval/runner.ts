/**
 * F-001 Task 10 — 평가 러너.
 *
 * 역할:
 * - 습관 샘플(data/habits/sample-50.json) × 세계관 조합을 실제 Claude Haiku로 변환
 * - 변환 결과에 대해 금지어 검출 / 교차 혼입 검사 수행
 * - 각 호출의 지연/토큰을 집계한 요약을 포함한 JSON 결과를 저장
 *
 * 출력 JSON 구조:
 * {
 *   runId: string,          // 실행 ID (타임스탬프 기반)
 *   model: string,
 *   worldviews: string[],
 *   startedAt: string,      // ISO 8601
 *   completedAt: string,
 *   items: Array<{
 *     habitId: string,
 *     habitText: string,
 *     worldviewId: string,
 *     quest: Quest | null,             // 변환 실패 시 null
 *     meta: TransformResponseMeta | null,
 *     checks: {
 *       forbiddenHit: boolean,         // 자기 세계관 바이블의 forbidden에 걸렸는지
 *       forbiddenMatches: string[],
 *       crossContamination: string[],  // 상대 세계관 바이블의 forbidden 매칭
 *     },
 *     error?: string,                  // 실패 시 예외 메시지
 *   }>,
 *   summary: {
 *     total: number,
 *     succeeded: number,
 *     failed: number,
 *     avgLatencyMs: number,
 *     p95LatencyMs: number,
 *     totalPromptTokens: number,
 *     totalCompletionTokens: number,
 *   }
 * }
 *
 * CLI 인자:
 * - --model=haiku|sonnet             기본 haiku (환경변수 CLAUDE_MODEL_HAIKU 또는
 *                                     "claude-haiku-4-5-20251001")
 * - --worldview=<id|all>             기본 all (kingdom_of_light + starlight_magic_school)
 * - --output=<path>                  기본 data/evaluations/run-<timestamp>.json
 * - --limit=<n>                      기본 0 (전체). 1 이상이면 세계관당 최대 n건 실행.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadBible } from "../core/prompt/load-bible.js";
import type { TransformResponseMeta } from "../core/schemas/api.js";
import type { Quest } from "../core/schemas/quest.js";
import { QuestTransformer } from "../core/transformer.js";
import { detectCrossContamination } from "./cross-worldview-checker.js";
import { checkForbidden } from "./forbidden-matcher.js";
import { MetricsCollector } from "./metrics.js";

const DEFAULT_WORLDVIEWS = ["kingdom_of_light", "starlight_magic_school"] as const;
const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_SONNET_MODEL = "claude-sonnet-4-5";

// 상대(=다른) 세계관 매핑 — 현재는 두 세계관 간 1:1 대응이지만,
// 향후 세계관이 추가되어도 이 테이블만 갱신하면 된다. filter(id !== cur) 같은
// 암시적 로직은 3번째가 생기는 순간 의미가 깨지므로 쓰지 않는다.
const COUNTERPART_WORLDVIEW: Record<string, string> = {
  kingdom_of_light: "starlight_magic_school",
  starlight_magic_school: "kingdom_of_light",
};

export type ModelShortName = "haiku" | "sonnet";

export interface RunOptions {
  /** 모델 이름 또는 별칭. 별칭이면 실제 모델 ID로 해석된다. */
  model: string;
  /** 실행 대상 세계관 ID 목록 */
  worldviews: string[];
  /** 출력 JSON 파일의 절대 경로 */
  output: string;
  /** 0이면 전체, 1 이상이면 세계관당 상한 */
  limit: number;
}

export interface ParsedArgs extends RunOptions {}

export interface HabitSample {
  id: string;
  text: string;
  type: string;
  expected_category: string;
}

export interface EvalItem {
  habitId: string;
  habitText: string;
  worldviewId: string;
  quest: Quest | null;
  meta: TransformResponseMeta | null;
  checks: {
    forbiddenHit: boolean;
    forbiddenMatches: string[];
    crossContamination: string[];
  };
  error?: string;
}

export interface EvalSummary {
  total: number;
  succeeded: number;
  failed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface EvalRunResult {
  runId: string;
  model: string;
  worldviews: string[];
  startedAt: string;
  completedAt: string;
  items: EvalItem[];
  summary: EvalSummary;
}

function resolveModelId(modelArg: string): string {
  if (modelArg === "haiku") {
    return process.env.CLAUDE_MODEL_HAIKU ?? DEFAULT_HAIKU_MODEL;
  }
  if (modelArg === "sonnet") {
    return process.env.CLAUDE_MODEL_SONNET ?? DEFAULT_SONNET_MODEL;
  }
  return modelArg;
}

function defaultOutputPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join("data", "evaluations", `run-${ts}.json`);
}

// 경로에 ".." 세그먼트가 있으면 거부 — 절대 경로(/tmp 등)는 허용한다.
function rejectTraversal(inputPath: string, label = "경로"): string {
  const parts = inputPath.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) {
    throw new Error(`${label}에 경로 탐색(..)이 포함됩니다: ${inputPath}`);
  }
  return inputPath;
}

function parseKeyValue(arg: string): [string, string] | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg.slice(2), ""];
  return [arg.slice(2, eq), arg.slice(eq + 1)];
}

/**
 * CLI 인자 파서.
 *
 * 숫자 파싱은 `Number.parseInt(..., 10)` 사용 후 `Number.isFinite` 로 확인한다.
 * 유효하지 않은 값은 기본값으로 fallback (0).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let model = "haiku";
  let worldviews: string[] = [...DEFAULT_WORLDVIEWS];
  let output: string | undefined;
  let limit = 0;

  for (const arg of argv) {
    const kv = parseKeyValue(arg);
    if (kv === null) continue;
    const [key, value] = kv;

    if (key === "model") {
      if (value.length > 0) model = value;
    } else if (key === "worldview") {
      if (value === "" || value === "all") {
        worldviews = [...DEFAULT_WORLDVIEWS];
      } else {
        worldviews = [value];
      }
    } else if (key === "output") {
      if (value.length > 0) output = rejectTraversal(value, "출력 경로");
    } else if (key === "limit") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) {
        limit = n;
      }
    }
  }

  return {
    model,
    worldviews,
    output: output ?? defaultOutputPath(),
    limit,
  };
}

function loadHabits(baseDir: string): HabitSample[] {
  const path = join(baseDir, "data", "habits", "sample-50.json");
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("sample-50.json은 배열이어야 합니다");
  }
  return parsed as HabitSample[];
}

function applyLimit<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return items;
  return items.slice(0, limit);
}

/**
 * 평가 실행.
 *
 * 개별 변환이 실패해도 전체 실행을 중단하지 않고 items에 error를 기록한 뒤 계속 진행한다.
 * Anthropic 클라이언트는 테스트에서 vi.mock("@anthropic-ai/sdk") 로 교체된다.
 */
export async function runEvaluation(options: RunOptions): Promise<EvalRunResult> {
  const runId = `run-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const modelId = resolveModelId(options.model);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const transformer = new QuestTransformer(client, modelId);

  // 세계관별 바이블을 미리 로드해 두고 counterpart 비교에 재사용.
  const bibles = new Map<string, ReturnType<typeof loadBible>>();
  for (const wvId of options.worldviews) {
    bibles.set(wvId, loadBible(wvId));
  }

  const habits = loadHabits(process.cwd());
  const items: EvalItem[] = [];
  const metrics = new MetricsCollector();

  for (const wvId of options.worldviews) {
    const ownBible = bibles.get(wvId);
    if (ownBible === undefined) continue;

    // 상대 세계관 — 매핑에 없으면 교차 검사 없이 건너뜀 (단일 세계관 실행 시나리오).
    const counterpartId = COUNTERPART_WORLDVIEW[wvId];
    let counterpartBible = counterpartId ? bibles.get(counterpartId) : undefined;
    if (counterpartBible === undefined && counterpartId !== undefined) {
      // counterpart가 --worldview 옵션에 없더라도 오염 검사용으로 로드 시도.
      try {
        counterpartBible = loadBible(counterpartId);
      } catch {
        counterpartBible = undefined;
      }
    }

    const targetHabits = applyLimit(habits, options.limit);

    for (const habit of targetHabits) {
      try {
        const result = await transformer.transform({
          habit_text: habit.text,
          worldview_id: wvId,
          age_group: "7-12",
          regenerate: false,
        });

        // checks 입력 텍스트: quest_name + description.
        // 퀘스트의 식별 가능한 모든 "문장" 영역을 포괄하면서 구조 필드(category 등)는 제외한다.
        const checkText = `${result.quest.quest_name}\n${result.quest.description}`;
        const forbidden = checkForbidden(checkText, ownBible.tone.forbidden);
        const cross = counterpartBible
          ? detectCrossContamination(checkText, ownBible, counterpartBible)
          : { leaked: [] };

        metrics.recordCall({
          model: modelId,
          latencyMs: result.meta.latency_ms,
          promptTokens: result.meta.prompt_tokens,
          completionTokens: result.meta.completion_tokens,
        });

        items.push({
          habitId: habit.id,
          habitText: habit.text,
          worldviewId: wvId,
          quest: result.quest,
          meta: result.meta,
          checks: {
            forbiddenHit: forbidden.hit,
            forbiddenMatches: forbidden.matches,
            crossContamination: cross.leaked,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 실패 로그는 stderr로만 남긴다 (stdout은 CLI 결과 요약에 사용).
        console.error(`[eval] ${habit.id}×${wvId} 변환 실패: ${message}`);
        items.push({
          habitId: habit.id,
          habitText: habit.text,
          worldviewId: wvId,
          quest: null,
          meta: null,
          checks: { forbiddenHit: false, forbiddenMatches: [], crossContamination: [] },
          error: message,
        });
      }
    }
  }

  const summary = metrics.summary();
  const succeeded = items.filter((it) => it.quest !== null).length;
  const failed = items.length - succeeded;

  const evalSummary: EvalSummary = {
    total: items.length,
    succeeded,
    failed,
    avgLatencyMs: summary?.avgLatencyMs ?? 0,
    p95LatencyMs: summary?.p95LatencyMs ?? 0,
    totalPromptTokens: summary?.totalPromptTokens ?? 0,
    totalCompletionTokens: summary?.totalCompletionTokens ?? 0,
  };

  const completedAt = new Date().toISOString();
  const result: EvalRunResult = {
    runId,
    // 출력에는 실제 호출한 모델 ID를 기록한다. 사용자 입력 별칭(options.model)은
    // 상위 툴링에서 필요하면 CLI 인자 로그로 별도 보존할 수 있다.
    model: modelId,
    worldviews: options.worldviews,
    startedAt,
    completedAt,
    items,
    summary: evalSummary,
  };

  // 출력 파일 기록 — 상위 디렉터리가 없으면 생성한다.
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, JSON.stringify(result, null, 2), "utf-8");

  return result;
}

// CLI 진입점.
// 모듈로 import될 때는 실행되지 않아야 하므로 argv[1]의 파일명이 이 모듈인지 확인한다.
// vitest는 argv[1]을 자체 러너로 설정하므로 아래 조건을 만족하지 않는다.
const entryArg = process.argv[1] ?? "";
if (entryArg.endsWith("runner.ts") || entryArg.endsWith("runner.js")) {
  // CLI 전용: 환경변수 미설정 시 즉시 종료 (모든 건을 실패 기록하는 것보다 낫다).
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[eval] fatal: ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.");
    process.exitCode = 1;
  } else {
    (async () => {
      const options = parseArgs(process.argv.slice(2));
      try {
        const result = await runEvaluation(options);
        console.error(
          `[eval] done: total=${result.summary.total} ok=${result.summary.succeeded} fail=${result.summary.failed} → ${options.output}`,
        );
      } catch (err) {
        console.error(`[eval] fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    })();
  }
}
