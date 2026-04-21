// LLM 응답에서 마크다운 코드펜스 언랩 유틸 — 공용.
//
// 앞뒤를 모두 감싼 ```json ... ``` 또는 ``` ... ``` 펜스만 제거한다.
// 펜스가 없으면 원문을 그대로 반환한다 (보수적).
//
// QuestTransformer / LightModifier 등 LLM 응답 JSON 파싱이 필요한 모든
// 호출기에서 단일 소스로 사용한다.

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (match && typeof match[1] === "string") {
    return match[1].trim();
  }
  return trimmed;
}
