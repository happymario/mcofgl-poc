// F-002 Task 8 — 시드 벡터 적재 CLI.
//
// 역할:
// - F-001 eval 러너가 생성한 결과 JSON(data/evaluations/run-*.json)을 읽어
//   각 item의 habitText + quest를 Vector DB(`quest_vectors`)에 `is_seed=true`로 적재한다.
// - quest가 null인 item은 건너뛴다(변환 실패한 샘플).
//
// CLI 인자:
// - --input=<path>  기본값: data/evaluations/run-2026-04-21T09-06-13-277Z.json
// - --dry-run       임베딩/저장 없이 시드 대상 건수만 출력 (네트워크 호출 없음)
//
// 완료 기준:
// - `npm run seed:vectors -- --dry-run` 실행 시 네트워크 호출 없이 "시드 대상 N건" 출력
// - 개별 실패는 기록하고 계속 진행(전체 중단 금지)
// - 완료 후 요약: `시드 적재 완료: 성공 N건, 실패 M건`
//
// 주의:
// - 이 스크립트는 infra 타입이라 단위 테스트가 없다. dry-run 모드가 환경변수 없이도
//   동작하도록, env 검증/클라이언트 생성은 dry-run 분기 이후에 수행한다.

import { readFileSync, readdirSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { EmbeddingService } from "../core/vector/embedding.js";
import { VectorStore } from "../core/vector/store.js";
import type { EvalRunResult } from "../eval/runner.js";

const EVAL_DIR = "data/evaluations";

// --input 미지정 시 EVAL_DIR에서 run-*.json 중 이름 기준 최신 파일을 자동 선택.
// 파일이 없으면 undefined를 반환해 호출부에서 에러로 처리한다.
function findLatestEvalRun(): string | undefined {
  try {
    const files = readdirSync(EVAL_DIR)
      .filter((f) => f.match(/^run-.*\.json$/) && !f.includes("blind") && !f.includes("answers"))
      .sort()
      .reverse();
    return files[0] ? `${EVAL_DIR}/${files[0]}` : undefined;
  } catch {
    return undefined;
  }
}

// PoC는 단일 age_group("7-12") 가정 (스펙 §3.4 기본값).
// 다중 연령대 지원 시 EvalItem에 age_group 필드를 추가하고 per-item으로 전환할 것.
const DEFAULT_AGE_GROUP = "7-12";

interface ParsedArgs {
  input: string;
  dryRun: boolean;
}

// 경로에 ".." 세그먼트가 있으면 거부한다 — runner.ts의 rejectTraversal와 동일 원칙.
// 절대 경로는 허용한다.
function rejectTraversal(inputPath: string, label = "입력 경로"): string {
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

export function parseArgs(argv: string[]): ParsedArgs {
  let input: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    const kv = parseKeyValue(arg);
    if (kv === null) continue;
    const [key, value] = kv;

    if (key === "input") {
      if (value.length > 0) input = rejectTraversal(value, "입력 경로");
    } else if (key === "dry-run") {
      dryRun = true;
    }
  }

  const resolvedInput = input ?? findLatestEvalRun();
  if (!resolvedInput) {
    throw new Error(
      `--input 인자가 없고 ${EVAL_DIR}/run-*.json 파일도 없습니다. --input=<path>로 명시하세요.`,
    );
  }
  return { input: resolvedInput, dryRun };
}

function loadEvalRun(path: string): EvalRunResult {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  // 스펙에 따라 Zod 없이 타입 단언으로 처리.
  // items 배열 존재 여부만 최소 가드한다.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error(`평가 JSON 형식이 올바르지 않습니다: ${path}`);
  }
  return parsed as EvalRunResult;
}

// 4개 환경변수 중 누락된 것들을 모두 모아 한 번에 보고한다.
// runner.ts는 단일 키만 검사하지만 여기서는 필요 키가 많아 missing-list가 유용하다.
function requireEnv(): {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openaiApiKey: string;
  openaiEmbeddingModel: string;
} {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const openaiEmbeddingModel = process.env.OPENAI_EMBEDDING_MODEL;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!openaiEmbeddingModel) missing.push("OPENAI_EMBEDDING_MODEL");

  if (missing.length > 0) {
    throw new Error(
      `필수 환경변수가 설정되지 않았습니다: ${missing.join(", ")}. .env 파일을 확인하세요.`,
    );
  }

  // 위 가드 덕분에 undefined가 아님이 보장되지만, 타입 시스템에는 non-null 단언이 필요하다.
  return {
    supabaseUrl: supabaseUrl as string,
    supabaseServiceRoleKey: supabaseServiceRoleKey as string,
    openaiApiKey: openaiApiKey as string,
    openaiEmbeddingModel: openaiEmbeddingModel as string,
  };
}

/**
 * 시드 적재 실행.
 *
 * - dry-run이면 필터 후 건수만 출력하고 종료 (네트워크 호출 없음).
 * - 그 외에는 각 item을 순차 처리: embed → save. 개별 실패는 기록하고 계속 진행.
 */
export async function runSeedVectors(args: ParsedArgs): Promise<void> {
  const run = loadEvalRun(args.input);

  // quest가 null인 item은 변환 실패로 시드 대상에서 제외.
  const seedTargets = run.items.filter((it) => it.quest !== null);

  console.error(
    `[seed] 입력: ${args.input} (전체 ${run.items.length}건, 시드 대상 ${seedTargets.length}건)`,
  );

  if (args.dryRun) {
    console.error(`[seed] dry-run: 시드 대상 ${seedTargets.length}건`);
    return;
  }

  // dry-run이 아닐 때만 환경변수 검증 + 클라이언트 생성.
  const env = requireEnv();
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const openai = new OpenAI({ apiKey: env.openaiApiKey });
  const embedding = new EmbeddingService(openai, env.openaiEmbeddingModel);
  const store = new VectorStore(supabase);

  const total = seedTargets.length;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const item = seedTargets[i];
    if (item === undefined) continue;
    const quest = item.quest;
    if (quest === null) continue; // filter로 이미 제외되지만 타입 좁히기 용도.

    const position = `${i + 1}/${total}`;
    try {
      const vector = await embedding.embed(item.habitText);
      await store.save({
        inputText: item.habitText,
        worldviewId: item.worldviewId,
        ageGroup: DEFAULT_AGE_GROUP,
        embedding: vector,
        quest,
        isSeed: true,
      });
      succeeded += 1;
      console.error(
        `[seed] ${position} habitId=${item.habitId} wv=${item.worldviewId} ✓`,
      );
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[seed] ${position} habitId=${item.habitId} wv=${item.worldviewId} ✗ ${message}`,
      );
    }
  }

  console.error(`시드 적재 완료: 성공 ${succeeded}건, 실패 ${failed}건`);

  // F-003 OQ-2 — worldview × age_group 조합별 is_seed=true 최소 1건 존재 검증.
  await verifySeedCoverage(supabase, seedTargets.map((it) => ({
    worldviewId: it.worldviewId,
    ageGroup: DEFAULT_AGE_GROUP,
  })));
}

interface CombinationKey {
  worldviewId: string;
  ageGroup: string;
}

async function verifySeedCoverage(
  supabase: SupabaseClient,
  combinations: CombinationKey[],
): Promise<void> {
  // 중복 제거
  const unique = new Map<string, CombinationKey>();
  for (const c of combinations) {
    unique.set(`${c.worldviewId}::${c.ageGroup}`, c);
  }

  const shortfall: string[] = [];

  for (const [, combo] of unique) {
    const { count, error } = await supabase
      .from("quest_vectors")
      .select("id", { count: "exact", head: true })
      .eq("worldview_id", combo.worldviewId)
      .eq("age_group", combo.ageGroup)
      .eq("is_seed", true);

    if (error) {
      console.error(
        `[seed] is_seed 검증 쿼리 실패 (${combo.worldviewId}/${combo.ageGroup}): ${error.message}`,
      );
      continue;
    }

    if ((count ?? 0) < 1) {
      shortfall.push(`${combo.worldviewId}/${combo.ageGroup}`);
    }
  }

  if (shortfall.length > 0) {
    console.error(
      `[seed] 경고: is_seed=true 퀘스트 부족 조합 ${shortfall.length}개 — ${shortfall.join(", ")}`,
    );
    console.error(`검증 결과: 부족 조합 ${shortfall.length}개`);
    process.exitCode = 2;
  } else {
    console.error(
      `[seed] is_seed 커버리지 검증 통과 — 전체 ${unique.size}개 조합 is_seed=true 최소 1건 확인`,
    );
    console.error(`검증 결과: 부족 조합 0개`);
  }
}

// CLI 진입점 — runner.ts와 동일한 import-safe 가드.
// vitest 또는 다른 모듈에서 import해도 아래 블록이 실행되지 않도록 확인한다.
const entryArg = process.argv[1] ?? "";
if (
  entryArg.endsWith("seed-vectors.ts") ||
  entryArg.endsWith("seed-vectors.js")
) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      await runSeedVectors(args);
    } catch (err) {
      console.error(
        `[seed] fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  })();
}
