// 스펙 §F-003 Task 4 — Safety Filter Layer 2: LLM 기반 검증기.
//
// 입력: Quest + ageGroup
// 출력: LlmVerifierResult — verdict(safe|borderline|unsafe) + optional reason + latency_ms
//
// 처리 흐름:
// 1) 시스템 프롬프트 + 사용자 메시지(연령대/퀘스트명/설명) 조립
// 2) Anthropic messages.create 1회 호출 (MAX_TOKENS=128, 재시도 없음)
// 3) 응답 텍스트 → stripCodeFence → JSON.parse → verdict enum 검증
// 4) 어떤 단계든 실패 시 fail-closed: verdict="unsafe" + console.error
// 5) latency_ms는 performance.now() 차분으로 계측
//
// 의존성 주입:
// - Anthropic 클라이언트는 생성자 주입 (테스트는 fake 객체로 교체 가능).
// - 모델명은 옵션, 기본값은 claude-haiku-4-5-20251001.

import type Anthropic from "@anthropic-ai/sdk";
import { stripCodeFence } from "../prompt/strip-code-fence.js";
import type { Quest } from "../schemas/quest.js";

export type LlmVerdict = "safe" | "borderline" | "unsafe";

export interface LlmVerifierResult {
  verdict: LlmVerdict;
  reason?: string;
  latency_ms: number;
}

// 응답 길이를 짧게 강제해 Haiku 호출 비용과 지연을 최소화한다.
// JSON 한 줄(`{"verdict":"...","reason":"..."}`)이면 128 토큰으로 충분하다.
const MAX_TOKENS = 128;

// 단일 LLM 호출 상한. 초과 시 AbortError → 기존 fail-closed 분기로 처리된다.
const CALL_TIMEOUT_MS = 4000;

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export const SYSTEM_PROMPT = `당신은 아동(7~12세) 대상 퀘스트 안전성 평가자입니다.
다음 퀘스트가 아동에게 적합한지 평가하세요.
폭력, 공포, 심한 부정감정, 성적 표현이 포함되면 unsafe입니다.
타인을 이기거나 제압하려는 경쟁 심리, 상대방의 약점을 공략하는 내용,
적대적 행동을 장려하는 표현도 아동에게 부적절하므로 unsafe입니다.
RPG 세계관의 일반적 전투 표현(예: 몬스터 처치, 퀘스트 달성)은 safe입니다.
경계선상이면 borderline, 안전하면 safe입니다.
반드시 JSON 한 줄로만 응답: {"verdict":"safe"|"borderline"|"unsafe","reason":"이유(선택)"}`;

const VALID_VERDICTS: readonly LlmVerdict[] = ["safe", "borderline", "unsafe"];

function isLlmVerdict(value: unknown): value is LlmVerdict {
  return typeof value === "string" && (VALID_VERDICTS as readonly string[]).includes(value);
}

// Anthropic 응답에서 첫 번째 텍스트 블록만 추출.
// 텍스트 블록이 없으면 throw → 상위 catch에서 fail-closed로 처리된다.
function extractText(message: Anthropic.Messages.Message): string {
  const first = message.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Anthropic 응답에 텍스트 블록이 없습니다");
  }
  return first.text;
}

function buildUserMessage(quest: Quest, ageGroup: string): string {
  const parts = [`연령대: ${ageGroup}`, `퀘스트명: ${quest.quest_name}`, `설명: ${quest.description}`];
  if (quest.reward.buff) {
    parts.push(`보상 설명: ${quest.reward.buff}`);
  }
  return parts.join("\n");
}

export class LlmVerifier {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async verify(quest: Quest, ageGroup: string): Promise<LlmVerifierResult> {
    const start = performance.now();

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserMessage(quest, ageGroup) }],
        },
        { timeout: CALL_TIMEOUT_MS },
      );

      const rawText = extractText(response);
      const unwrapped = stripCodeFence(rawText);
      const parsed: unknown = JSON.parse(unwrapped);

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("LLM 응답 JSON이 객체가 아닙니다");
      }

      const payload = parsed as Record<string, unknown>;
      const verdict = payload.verdict;

      if (!isLlmVerdict(verdict)) {
        throw new Error(`LLM 응답의 verdict 값이 유효하지 않습니다: ${String(verdict)}`);
      }

      const result: LlmVerifierResult = {
        verdict,
        latency_ms: performance.now() - start,
      };

      if (typeof payload.reason === "string" && payload.reason.length > 0) {
        result.reason = payload.reason;
      }

      return result;
    } catch (cause) {
      // fail-closed: 어떤 실패도 unsafe로 보수적 취급.
      console.error("[LlmVerifier] 검증 실패로 fail-closed(unsafe) 처리", cause);
      return {
        verdict: "unsafe",
        reason: "LLM 검증 실패",
        latency_ms: performance.now() - start,
      };
    }
  }
}
