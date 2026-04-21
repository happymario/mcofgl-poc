/**
 * F-001 Task 11 — 블라인드 평가 아티팩트 생성기.
 *
 * 역할:
 * - Task 10의 평가 러너 결과(JSON)에서 두 세계관 **모두** 성공(quest != null)한
 *   habitId만 추출하고, 세계관 라벨을 제거한 CSV와 별도의 정답(JSON)을 생성한다.
 * - 사람 평가자가 세계관을 맞히는 블라인드 테스트용 입력 파일을 만드는 용도다.
 *
 * 입력:
 *   runEvaluation이 저장한 JSON 파일. 필요한 필드:
 *     items[]: { habitId, worldviewId, quest: { quest_name, description } | null }
 *     runId: 기본 출력 경로 계산에 사용
 *
 * 출력:
 *   1) CSV — 헤더: `itemId,quest_name,description` (worldview_id 컬럼 없음)
 *      RFC 4180 규칙으로 쉼표/줄바꿈/큰따옴표를 이스케이프한다.
 *   2) answers.json — { "b001": "<worldview_id>", ... }
 *
 * 선택 전략:
 *   - 두 세계관 모두에 quest != null 로 성공한 habitId 만 추려낸다 (교집합).
 *   - 결과가 maxHabits (기본 20)를 초과하면 habitId 오름차순 기준 앞에서부터 잘라낸다.
 *     잘라내는 순서는 결정적이어야 리뷰/재현이 가능하다. 세계관 간 편향을 피하려면
 *     "하나의 habitId가 선택되면 두 세계관 모두 포함" 을 보장해야 하므로
 *     세계관 단위가 아닌 habit 단위로 선택한다.
 *   - 선택된 항목들을 무작위 섞은 뒤 itemId(b001, b002, ...) 를 부여한다.
 *     순서 예측 가능성을 더 낮추기 위해 Fisher-Yates shuffle을 적용한다. 테스트는 순서
 *     비의존적이므로 seed 고정이 필요 없다.
 *
 * CLI 인자:
 *   --run=<path>       (필수)
 *   --output=<path>    기본값: <run-dir>/<run-id>-blind.csv
 *   --answers=<path>   기본값: <run-dir>/<run-id>-answers.json
 *   --max-habits=<n>   (선택) 기본 20
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface BlindGeneratorOptions {
  /** 입력: runEvaluation 결과 JSON 경로 */
  runPath: string;
  /** 출력: CSV 경로 (worldview_id 컬럼 없음) */
  outputPath: string;
  /** 출력: 정답 JSON 경로 */
  answersPath: string;
  /** 두 세계관에 모두 있는 습관 최대 수 — 기본 20 */
  maxHabits?: number;
}

export interface BlindItem {
  itemId: string;
  questName: string;
  description: string;
}

export interface BlindAnswers {
  [itemId: string]: string;
}

export interface BlindGeneratorResult {
  csvRows: number;
  answersCount: number;
}

// 입력 JSON의 필요한 최소 스키마만 정의한다 (runner.ts와 강결합 방지).
interface RunItemLike {
  habitId: string;
  worldviewId: string;
  quest:
    | {
        quest_name: string;
        description: string;
      }
    | null;
}

interface RunResultLike {
  runId?: string;
  worldviews?: string[];
  items: RunItemLike[];
}

const DEFAULT_MAX_HABITS = 20;

/**
 * RFC 4180 규칙에 맞춰 CSV 필드 하나를 인코딩한다.
 *
 * - 쉼표/개행(\n,\r)/큰따옴표(") 중 하나라도 포함되면 큰따옴표로 감싼다.
 * - 필드 내 " 는 "" 로 이중화한다.
 */
function escapeCsvField(value: string): string {
  const needsQuoting = /[",\r\n]/.test(value);
  if (!needsQuoting) return value;
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Fisher-Yates 섞기 — 배열을 제자리 수정한다. 제자리 수정은 caller가 복사본을
 * 넘긴다는 계약이 있을 때만 안전하다. 여기서는 내부에서만 호출하므로 caller가
 * 전용 배열을 넘긴다.
 */
function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
}

/**
 * items[]에서 "모든 세계관에 quest != null 로 존재하는 habitId" 의 집합을 구한다.
 *
 * 두 세계관(PoC 현재 전제)뿐 아니라 N개 세계관으로 일반화된다.
 * worldviews 목록은 입력 JSON의 worldviews 필드를 우선하고, 없으면 items에서
 * 유니크한 worldviewId 집합으로 대체한다.
 */
function collectCommonHabitIds(run: RunResultLike): string[] {
  const worldviews =
    run.worldviews && run.worldviews.length > 0
      ? [...run.worldviews]
      : Array.from(new Set(run.items.map((i) => i.worldviewId)));

  // habitId → 성공한 세계관 집합
  const successByHabit = new Map<string, Set<string>>();
  for (const item of run.items) {
    if (item.quest === null) continue;
    let set = successByHabit.get(item.habitId);
    if (set === undefined) {
      set = new Set<string>();
      successByHabit.set(item.habitId, set);
    }
    set.add(item.worldviewId);
  }

  const commons: string[] = [];
  for (const [habitId, wvSet] of successByHabit) {
    let hasAll = true;
    for (const wv of worldviews) {
      if (!wvSet.has(wv)) {
        hasAll = false;
        break;
      }
    }
    if (hasAll) commons.push(habitId);
  }

  // habitId 오름차순 — 상한 초과 시 결정적 선택을 위해 정렬한다.
  commons.sort();
  return commons;
}

function formatItemId(index: number): string {
  // b001, b002, ... — 999 초과는 현재 PoC 스코프를 벗어난다.
  return `b${String(index).padStart(3, "0")}`;
}

export async function generateBlindArtifacts(
  options: BlindGeneratorOptions,
): Promise<BlindGeneratorResult> {
  const maxHabits = options.maxHabits ?? DEFAULT_MAX_HABITS;
  if (maxHabits <= 0) {
    throw new Error(`maxHabits는 1 이상이어야 합니다: ${maxHabits}`);
  }

  const raw = readFileSync(options.runPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { items?: unknown }).items)
  ) {
    throw new Error("입력 JSON에 items 배열이 필요합니다");
  }
  const run = parsed as RunResultLike;

  // 1) 두 세계관 모두 성공한 habitId 추출 (교집합)
  const eligible = collectCommonHabitIds(run);
  const chosen = eligible.slice(0, maxHabits);
  const chosenSet = new Set(chosen);

  // 2) 선택된 habitId × 세계관별 성공 항목을 모두 수집
  interface StagingItem {
    habitId: string;
    worldviewId: string;
    questName: string;
    description: string;
  }
  const staging: StagingItem[] = [];
  for (const item of run.items) {
    if (item.quest === null) continue;
    if (!chosenSet.has(item.habitId)) continue;
    staging.push({
      habitId: item.habitId,
      worldviewId: item.worldviewId,
      questName: item.quest.quest_name,
      description: item.quest.description,
    });
  }

  // 3) 순서에서 세계관 패턴이 드러나지 않도록 섞기
  shuffleInPlace(staging);

  // 4) itemId 부여 및 CSV/answers 구성
  const answers: BlindAnswers = {};
  const csvLines: string[] = ["itemId,quest_name,description"];
  for (let i = 0; i < staging.length; i += 1) {
    const s = staging[i] as StagingItem;
    const itemId = formatItemId(i + 1);
    answers[itemId] = s.worldviewId;
    csvLines.push(
      [
        escapeCsvField(itemId),
        escapeCsvField(s.questName),
        escapeCsvField(s.description),
      ].join(","),
    );
  }

  // 5) 파일 기록 — 상위 디렉터리가 없으면 생성
  mkdirSync(dirname(options.outputPath), { recursive: true });
  // CSV는 RFC 4180 규칙을 따르며, 최종 줄바꿈을 포함한다.
  writeFileSync(options.outputPath, `${csvLines.join("\n")}\n`, "utf-8");

  mkdirSync(dirname(options.answersPath), { recursive: true });
  writeFileSync(options.answersPath, `${JSON.stringify(answers, null, 2)}\n`, "utf-8");

  return {
    csvRows: staging.length,
    answersCount: Object.keys(answers).length,
  };
}

// --- CLI ---

interface CliOptions {
  runPath: string;
  outputPath?: string;
  answersPath?: string;
  maxHabits?: number;
}

function parseKeyValue(arg: string): [string, string] | null {
  if (!arg.startsWith("--")) return null;
  const eq = arg.indexOf("=");
  if (eq < 0) return [arg.slice(2), ""];
  return [arg.slice(2, eq), arg.slice(eq + 1)];
}

export function parseCliArgs(argv: string[]): CliOptions {
  let runPath: string | undefined;
  let outputPath: string | undefined;
  let answersPath: string | undefined;
  let maxHabits: number | undefined;

  for (const arg of argv) {
    const kv = parseKeyValue(arg);
    if (kv === null) continue;
    const [key, value] = kv;
    if (key === "run" && value.length > 0) runPath = value;
    else if (key === "output" && value.length > 0) outputPath = value;
    else if (key === "answers" && value.length > 0) answersPath = value;
    else if (key === "max-habits") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) maxHabits = n;
    }
  }

  if (runPath === undefined) {
    throw new Error("--run=<path> 인자가 필요합니다");
  }

  return { runPath, outputPath, answersPath, maxHabits };
}

/**
 * 기본 출력 경로: run JSON 옆에 동일 runId 기반 파일명을 둔다.
 * runId를 JSON에서 꺼내지 못하면 run 파일명에서 확장자를 떼고 사용한다.
 */
function deriveDefaultPaths(runPath: string): { csv: string; answers: string } {
  const dir = dirname(runPath);
  let runId: string;
  try {
    const parsed = JSON.parse(readFileSync(runPath, "utf-8")) as { runId?: unknown };
    if (typeof parsed.runId === "string" && parsed.runId.length > 0) {
      runId = parsed.runId;
    } else {
      runId = basename(runPath).replace(/\.json$/, "");
    }
  } catch {
    runId = basename(runPath).replace(/\.json$/, "");
  }
  return {
    csv: join(dir, `${runId}-blind.csv`),
    answers: join(dir, `${runId}-answers.json`),
  };
}

// 모듈로 import될 때는 실행되지 않도록 argv[1] 파일명을 확인한다.
const entryArg = process.argv[1] ?? "";
if (
  entryArg.endsWith("blind-generator.ts") ||
  entryArg.endsWith("blind-generator.js")
) {
  (async () => {
    try {
      const cli = parseCliArgs(process.argv.slice(2));
      const defaults = deriveDefaultPaths(cli.runPath);
      const result = await generateBlindArtifacts({
        runPath: cli.runPath,
        outputPath: cli.outputPath ?? defaults.csv,
        answersPath: cli.answersPath ?? defaults.answers,
        maxHabits: cli.maxHabits,
      });
      console.error(
        `[blind] done: rows=${result.csvRows} answers=${result.answersCount} → ${cli.outputPath ?? defaults.csv}`,
      );
    } catch (err) {
      console.error(`[blind] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  })();
}
