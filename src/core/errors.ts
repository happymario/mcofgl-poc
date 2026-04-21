// F-001 Task 6 — QuestTransformer 전용 에러 타입.
//
// - ParseError: LLM 응답에서 JSON을 추출/파싱하지 못했을 때.
// - ValidationError: JSON 파싱은 성공했으나 QuestSchema 검증에 실패했을 때.
//
// 두 에러 타입을 분리해 호출부가 재시도 정책과 사용자 메시지를 구분할 수 있도록 한다.

export class ParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ParseError";
  }
}

export class ValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ValidationError";
  }
}
