// F-002 Task 5 — LightModifier.
//
// 책임:
// - 유사도 0.7~0.9 구간(경량 수정 구간)에서 기존 퀘스트(baseQuest)를
//   새 habit_text 의 의도에 맞게 "표현만" 수정한다.
// - 카테고리/스탯/보상/등급 등의 구조는 최대한 보존하고, quest_name /
//   description 정도만 새 habitText에 맞춰 다시 쓴다.
//
// 정책:
// - 단일 시도(no retry). 파싱 실패 시 즉시 ParseError throw.
//   재시도/temperature 하향 루프는 QuestTransformer에만 있다.
// - Anthropic 응답의 original_habit / worldview_id 는 요청값으로 강제 주입
//   (LLM 할루시네이션 차단).
//
// 설계 주석:
// - OQ-2 결정: 시스템 프롬프트에 기존 퀘스트 "전체"를 JSON으로 전달한다.
//   대안: quest_name만 전달 → 컨텍스트가 부족해 description 일관성이 떨어질 수 있음.
//   결정 이유: 경량 수정 구간의 핵심은 "기존 표현 유지"이므로 스탯/보상/등급까지
//   함께 보여주어 LLM이 원형을 유지하도록 앵커링한다.

import type Anthropic from "@anthropic-ai/sdk";
import { ParseError, ValidationError } from "./errors.js";
import { stripCodeFence } from "./prompt/strip-code-fence.js";
import { type Quest, QuestSchema } from "./schemas/quest.js";

// 경량 수정은 출력 길이 상한이 원본 Transformer보다 크게 필요하지 않다.
const MAX_TOKENS = 1024;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// Anthropic 응답에서 첫 번째 텍스트 블록만 추출.
function extractText(message: Anthropic.Messages.Message): string {
  const first = message.content[0];
  if (!first || first.type !== "text") {
    throw new ParseError("Anthropic 응답에 텍스트 블록이 없습니다");
  }
  return first.text;
}

function buildSystemPrompt(params: {
  habitText: string;
  ageGroup: string;
  baseQuest: Quest;
}): string {
  const baseQuestJson = JSON.stringify(params.baseQuest, null, 2);
  return [
    "당신은 기존 퀘스트를 새 습관 문장에 맞춰 경량 수정하는 작가입니다.",
    "",
    "## 지시",
    "- 아래 [기존 퀘스트]의 구조(category, stat_mapping, reward, suggested_grade,",
    "  mandatory_suitability)는 최대한 유지하세요.",
    "- quest_name 과 description 만 새 [habit_text]의 의도에 맞게 자연스럽게 다시 쓰세요.",
    "- 세계관 톤과 어휘는 기존 퀘스트의 표현 방식을 따르세요.",
    "- 출력은 JSON 객체 하나만 (코드펜스는 허용).",
    "",
    `[대상 연령] ${params.ageGroup}세`,
    "",
    "[기존 퀘스트]",
    baseQuestJson,
    "",
    "[새 habit_text]",
    params.habitText,
  ].join("\n");
}

export class LightModifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly baseTemperature: number = 0.3,
  ) {
    if (baseTemperature < 0 || baseTemperature > 1) {
      throw new RangeError("baseTemperature는 [0, 1] 범위여야 합니다");
    }
  }

  async modify(params: {
    habitText: string;
    worldviewId: string;
    ageGroup: string;
    baseQuest: Quest;
  }): Promise<{
    quest: Quest;
    usage: { model: string; prompt_tokens: number; completion_tokens: number };
  }> {
    const system = buildSystemPrompt({
      habitText: params.habitText,
      ageGroup: params.ageGroup,
      baseQuest: params.baseQuest,
    });

    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: clamp01(this.baseTemperature),
        system,
        messages: [{ role: "user", content: params.habitText }],
      });
    } catch (cause) {
      throw new ParseError("Anthropic API 호출 실패", cause);
    }

    let parsedJson: Record<string, unknown>;
    try {
      const raw = extractText(response);
      const unwrapped = stripCodeFence(raw);
      const json: unknown = JSON.parse(unwrapped);
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new ParseError("LLM 응답 JSON이 객체가 아닙니다");
      }
      parsedJson = json as Record<string, unknown>;
    } catch (cause) {
      throw cause instanceof ParseError
        ? cause
        : new ParseError("LLM 응답 파싱 실패", cause);
    }

    // original_habit / worldview_id 는 요청값으로 강제 주입.
    const parsedQuest = QuestSchema.safeParse({
      ...parsedJson,
      original_habit: params.habitText,
      worldview_id: params.worldviewId,
    });

    if (!parsedQuest.success) {
      throw new ValidationError(
        `Quest 스키마 검증 실패: ${parsedQuest.error.message}`,
        parsedQuest.error,
      );
    }

    return {
      quest: parsedQuest.data,
      usage: {
        model: this.model,
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
    };
  }
}
