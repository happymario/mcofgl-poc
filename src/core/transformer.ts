// F-001 Task 6 — QuestTransformer.
//
// 책임:
// - Anthropic Claude 호출 (messages.create)
// - 응답 텍스트에서 마크다운 코드펜스를 제거하고 JSON 추출/파싱
// - QuestSchema로 Zod 검증
// - 성능 메타(지연/토큰) 측정 및 TransformResponse 반환
// - 파싱/검증 실패 시 temperature를 하향해 1회 재시도 (총 2회 시도)
// - regenerate=true 시 temperature를 상향하고 system 프롬프트에 고유 nonce 주입
//
// 의존성 주입:
// - Anthropic 클라이언트는 생성자 주입 (테스트는 vi.mock으로 교체 가능)

import type Anthropic from "@anthropic-ai/sdk";
import { ParseError, ValidationError } from "./errors.js";
import { assembleSystemPrompt } from "./prompt/assemble.js";
import { loadBible } from "./prompt/load-bible.js";
import { stripCodeFence } from "./prompt/strip-code-fence.js";
import type { TransformRequest, TransformResponse } from "./schemas/api.js";
import { QuestSchema } from "./schemas/quest.js";

// 스펙 §6.1 R-002 기준으로 퀘스트 출력 길이가 충분한 상한.
const MAX_TOKENS = 1024;
const REGENERATE_TEMPERATURE_BOOST = 0.3;
const RETRY_TEMPERATURE_FACTOR = 0.5;
const MAX_ATTEMPTS = 2;

// temperature는 Anthropic API 기준 [0, 1] 범위여야 한다.
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// 단조 증가 카운터 — Date.now() 단독으로는 동일 밀리초 충돌 발생 가능.
let nonceCounter = 0;
function generateNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}-${nonceCounter.toString(36)}`;
}

// 코드펜스 언랩 유틸은 `./prompt/strip-code-fence.js`로 분리되었다 (공용).

// Anthropic 응답에서 첫 번째 텍스트 블록만 추출.
// content가 비거나 tool_use 등 비-텍스트 블록이면 ParseError (재시도 대상).
function extractText(message: Anthropic.Messages.Message): string {
  const first = message.content[0];
  if (!first || first.type !== "text") {
    throw new ParseError("Anthropic 응답에 텍스트 블록이 없습니다");
  }
  return first.text;
}

export class QuestTransformer {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly baseTemperature: number = 0.7,
  ) {
    if (baseTemperature < 0 || baseTemperature > 1) {
      throw new RangeError("baseTemperature는 [0, 1] 범위여야 합니다");
    }
  }

  async transform(req: TransformRequest): Promise<TransformResponse> {
    const start = Date.now();

    const bible = loadBible(req.worldview_id);
    const baseSystem = assembleSystemPrompt({
      bible,
      ageGroup: req.age_group,
      characterContext: req.character_context,
    });

    const system = req.regenerate
      ? `${baseSystem}\n\n// regen: ${generateNonce()}`
      : baseSystem;

    const regenTemperature = clamp01(this.baseTemperature + REGENERATE_TEMPERATURE_BOOST);
    const baseEffective = req.regenerate ? regenTemperature : this.baseTemperature;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const temperature =
        attempt === 0
          ? baseEffective
          : clamp01(this.baseTemperature * RETRY_TEMPERATURE_FACTOR);

      let response: Anthropic.Messages.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          temperature,
          system,
          messages: [{ role: "user", content: req.habit_text }],
        });
      } catch (cause) {
        lastError = new ParseError("Anthropic API 호출 실패", cause);
        continue;
      }

      // extractText, JSON.parse, 객체 타입 확인을 동일 try 블록에서 처리.
      // 어느 단계에서든 실패하면 ParseError로 취급해 재시도한다.
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
        lastError =
          cause instanceof ParseError
            ? cause
            : new ParseError("LLM 응답 파싱 실패", cause);
        continue;
      }

      // original_habit / worldview_id는 요청값으로 강제 주입 (LLM 할루시네이션 차단).
      const parsedQuest = QuestSchema.safeParse({
        ...parsedJson,
        original_habit: req.habit_text,
        worldview_id: req.worldview_id,
      });

      if (!parsedQuest.success) {
        lastError = new ValidationError(
          `Quest 스키마 검증 실패: ${parsedQuest.error.message}`,
          parsedQuest.error,
        );
        continue;
      }

      return {
        quest: parsedQuest.data,
        meta: {
          model: this.model,
          latency_ms: Date.now() - start,
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
        },
      };
    }

    throw lastError ?? new ParseError("LLM 호출에 실패했습니다");
  }
}
