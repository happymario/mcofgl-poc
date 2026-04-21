// data/worldviews/*.json 파일을 WorldviewBibleSchema로 검증한다.
// few_shots의 각 quest는 QuestSchema로 추가 교차 검증해 실패 시 어느 few_shot인지 명확히 보고한다.
// 프롬프트 템플릿(Task 4 이후)이 동일한 바이블을 로드하므로 CI/로컬에서 선제적으로 스키마를 지킨다.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QuestSchema } from "../src/core/schemas/quest.js";
import { WorldviewBibleSchema, type WorldviewBible } from "../src/core/schemas/worldview.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const worldviewsDir = join(repoRoot, "data", "worldviews");

type ValidationFailure = {
  file: string;
  message: string;
};

type ValidationOutcome =
  | { ok: true; bible: WorldviewBible }
  | { ok: false; failure: ValidationFailure };

function listWorldviewFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir);
    return entries
      .filter((name) => name.endsWith(".json"))
      .filter((name) => statSync(join(dir, name)).isFile())
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function validateFile(filePath: string): ValidationOutcome {
  const raw = readFileSync(filePath, "utf-8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      failure: {
        file: filePath,
        message: `JSON 파싱 실패: ${(error as Error).message}`,
      },
    };
  }

  const bibleResult = WorldviewBibleSchema.safeParse(parsedJson);
  if (!bibleResult.success) {
    const issueSummary = bibleResult.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    return {
      ok: false,
      failure: {
        file: filePath,
        message: `WorldviewBibleSchema 검증 실패:\n${issueSummary}`,
      },
    };
  }

  // few_shots 교차 검증 — 탑레벨 파싱에서 이미 QuestSchema를 포함하지만,
  // 항목 단위 오류 메시지를 명시적으로 출력하기 위해 별도 루프를 돈다.
  const bible = bibleResult.data;
  for (let i = 0; i < bible.few_shots.length; i += 1) {
    const fewShot = bible.few_shots[i];
    if (!fewShot) continue;
    const questResult = QuestSchema.safeParse(fewShot.quest);
    if (!questResult.success) {
      const issueSummary = questResult.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      return {
        ok: false,
        failure: {
          file: filePath,
          message: `few_shots[${i}].quest QuestSchema 검증 실패 (habit: "${fewShot.habit}"):\n${issueSummary}`,
        },
      };
    }
  }

  return { ok: true, bible };
}

function main(): void {
  const files = listWorldviewFiles(worldviewsDir);
  if (files.length === 0) {
    console.error(`[validate:worldviews] ${worldviewsDir}에서 *.json 파일을 찾지 못했습니다.`);
    process.exit(1);
  }

  const failures: ValidationFailure[] = [];

  for (const file of files) {
    const filePath = join(worldviewsDir, file);
    const outcome = validateFile(filePath);
    if (!outcome.ok) {
      failures.push(outcome.failure);
      console.error(`[FAIL] ${file}\n${outcome.failure.message}`);
      continue;
    }

    const { bible } = outcome;
    const vocabCount = Object.keys(bible.vocabulary).length;
    const fewShotCount = bible.few_shots.length;
    const npcCount = bible.npcs.length;
    console.log(
      `[OK] ${file} — id=${bible.id}, vocabulary=${vocabCount}, few_shots=${fewShotCount}, npcs=${npcCount}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n[validate:worldviews] ${failures.length}개 파일 검증 실패`);
    process.exit(1);
  }

  console.log(`\n[validate:worldviews] 총 ${files.length}개 파일 모두 검증 통과`);
}

main();
