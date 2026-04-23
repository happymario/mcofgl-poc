---
last_modified: 2026-04-23
author: @mario
status: Active
---

# F-004 퀘스트 생성 통합 API

> F-001(LLM 변환) · F-002(Vector DB 재활용) · F-003(안전 필터)를 단일 `POST /api/quest/generate` 엔드포인트로 통합하고, Redis 캐시 레이어 · Graceful Degradation · PRD 확정 응답 스키마 · 비용 추적 메타데이터를 추가한 PoC 완성 단계.

## 개요

F-001 ~ F-003은 각각 독립 구현되어 있었으나 다음이 없었다: Redis 캐시(동일 습관 재요청 시 LLM/VectorDB 비용 없이 빠른 응답), Graceful Degradation(외부 서비스 장애 시 유효한 퀘스트 반환 보장), PRD 확정 응답 스키마(MVP 앱 연동 계약), 비용 추적 메타데이터.

F-004는 새 `IntegratedPipeline` 클래스를 도입해 이를 완성한다. `IntegratedPipeline`은 기존 `QuestRetriever`를 래핑하며 Redis 캐시 조회 → QuestRetriever 호출 → 장애 복구 체인을 조립한다. 기존 `/api/quest/transform` 계약과 `QuestRetriever` 내부 로직은 변경하지 않는다.

**기술 스택 추가**: ioredis(Redis 클라이언트).

## 구조 / 스키마

### 디렉토리 구조

```
src/
├── config.ts                            MODEL_PRICING 상수 + estimateCostUsd
├── api/
│   ├── server.ts                        buildServer(transformer, pipeline?) — pipeline 주입 시 /generate 등록
│   └── index.ts                         전체 조립 + Redis 초기화 + graceful shutdown
├── core/
│   ├── cache.ts                         RedisCache (buildCacheKey + get/set)
│   ├── pipeline.ts                      IntegratedPipeline (5-path routing + degradation)
│   ├── modifier.ts                      LightModifier — modify() returns {quest, usage}
│   ├── retriever.ts                     QuestRetriever — RetrieveMeta에 llm_usage 필드 추가
│   ├── transformer.ts                   QuestTransformer — transform(req, options?) 시그니처 확장
│   └── schemas/
│       └── api.ts                       GenerateResponseMetaSchema (8-field PRD 계약)
└── eval/
    └── integrated-runner.ts             eval:integrated CLI + computeIntegratedMetrics
```

### GenerateResponseMeta 스키마

`/api/quest/generate` 응답 meta 필드는 F-003 기준 스키마에서 F-004 PRD 계약으로 전면 교체된다.

```typescript
export const GenerateResponseMetaSchema = z.object({
  processing_path: z.enum(["cache", "vector_exact", "vector_modify", "llm_new", "fallback"]),
  similarity_score: z.number().nullable(),
  safety_check: z.enum(["passed", "replaced", "fallback"]),
  latency_ms: z.number(),
  model_used: z.string().nullable(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  estimated_cost_usd: z.number(),
});
```

제거된 필드: `path`, `similarity`, `filter_result`. 이 변경은 `/api/quest/generate` 엔드포인트에만 적용되며 `/api/quest/transform` 계약은 불변이다.

### 5개 처리 경로별 메타 매핑

| processing_path | 조건 | model_used | prompt_tokens / completion_tokens | estimated_cost_usd |
|---|---|---|---|---|
| `cache` | `regenerate=false` + Redis HIT | `null` | `0 / 0` | `0` |
| `vector_exact` | sim ≥ 0.9 | `null` | `0 / 0` | `0` |
| `vector_modify` | 0.7 ≤ sim < 0.9 | `LightModifier.model` | Anthropic `usage` | `단가 × 토큰` |
| `llm_new` | sim < 0.7, safety passed/replaced; 또는 retriever 장애 후 transformer 직접 호출 성공 | `QuestTransformer.model` | Anthropic `usage` | `단가 × 토큰` |
| `fallback` | `llm_new + blocked`; retriever 장애 후 transformer도 실패 또는 blocked; retriever timeout | `null` | `0 / 0` | `0` |

### 핵심 타입

```typescript
// modifier.ts — usage 반환 타입 확장
async modify(params, options?: { signal?: AbortSignal }): Promise<{
  quest: Quest;
  usage: { model: string; prompt_tokens: number; completion_tokens: number };
}>

// retriever.ts — RetrieveMeta에 llm_usage 추가
export interface RetrieveMeta {
  path: RoutingPath
  similarity: number | null
  latency_ms: number
  filter_result?: FilterResult
  llm_usage?: { model: string; prompt_tokens: number; completion_tokens: number }
}

// transformer.ts — options 파라미터 추가
async transform(req: TransformRequest, options?: { signal?: AbortSignal }): Promise<TransformResponse>

// pipeline.ts — 의존성 주입 인터페이스
export interface IntegratedPipelineDeps {
  retriever: Pick<QuestRetriever, "retrieve">;
  transformer: Pick<QuestTransformer, "transform">;
  fallback: Pick<FallbackSelector, "select">;
  cache?: Pick<RedisCache, "get" | "set">;
  safetyPipeline?: Pick<SafetyFilterPipeline, "apply">;
  timeoutMs?: number;
}
```

### 캐시 키 구성

```
md5(habit_text + ":" + worldview_id + ":" + age_group + ":" + ctxStr)
// ctxStr = character_context 있으면 JSON.stringify(character_context), 없으면 ""
```

`character_context`를 포함한다. 동일 `habit_text + worldview_id + age_group`이라도 `character_context`가 다르면 별도 키가 생성된다(cross-context 오염 방지). `worldview_id`는 `[a-z0-9_-]` 패턴, `age_group`은 `\d-\d` 형식으로 제한되어 `:` 구분자 충돌 위험이 없다.

### 모델 단가 (`src/config.ts`)

```typescript
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": { input_per_1m_usd: 0.8,  output_per_1m_usd: 4.0  },
  "claude-sonnet-4-5":         { input_per_1m_usd: 3.0,  output_per_1m_usd: 15.0 },
};
```

현재 2개 모델만 등록되어 있다. 미등록 모델은 `estimateCostUsd`가 0을 반환한다.

## 동작

### API

```
POST /api/quest/generate
Content-Type: application/json
```

요청 스키마는 F-002 `GenerateRequestSchema`와 동일하다(`TransformRequestSchema`와 공유).

**응답 (200)**:

```json
{
  "quest": { /* QuestSchema (F-001 동일) */ },
  "meta": {
    "processing_path": "llm_new",
    "similarity_score": null,
    "safety_check": "passed",
    "latency_ms": 1420,
    "model_used": "claude-haiku-4-5-20251001",
    "prompt_tokens": 1800,
    "completion_tokens": 250,
    "estimated_cost_usd": 0.000244
  }
}
```

**에러 응답**:

| 상태 코드 | 조건 |
|-----------|------|
| `400` | 입력 검증 실패 (habit_text 길이, worldview_id 형식 위반 등) |
| `422` | LLM 응답 파싱 실패 또는 Quest 스키마 검증 실패 |
| `500` | 그 외 내부 오류 (원인 미노출) |

### IntegratedPipeline 처리 흐름

```
POST /api/quest/generate
  → IntegratedPipeline.run(req)

① [regenerate=false] cache?.get(buildCacheKey(req))
   → HIT:  processing_path="cache", safety_check="passed", tokens=0, cost=0
           original_habit / worldview_id는 현재 요청값으로 강제 주입
   → MISS 또는 cache 미주입: 다음 단계 진행

② Promise.race([retriever.retrieve(req), timeout(10s)])
   → vector_exact:  processing_path="vector_exact", safety_check="passed", tokens=0
   → vector_modify:  processing_path="vector_modify", safety_check=mapFilter(filter_result)
                     usage는 RetrieveMeta.llm_usage에서 읽음
   → llm_new + blocked=false:  processing_path="llm_new", safety_check=mapFilter(filter_result)
                                usage는 RetrieveMeta.llm_usage에서 읽음
                                cache?.set(key, quest) 호출 (베스트-에포트)
   → llm_new + blocked=true:   processing_path="fallback", safety_check="fallback", tokens=0

③ [retriever throw 또는 timeout] 복구 경로:
   transformer.transform(req, { signal: AbortSignal.timeout(10s) }) 직접 호출
   → 성공 + safetyPipeline 주입:
     · safe/replaced → processing_path="llm_new", safety_check=mapFilter, transformer usage 사용
                       (복구 경로 결과는 캐시에 저장하지 않음)
     · blocked → fallback.select() 명시 호출 → processing_path="fallback"
   → 성공 + safetyPipeline 미주입:
     → processing_path="llm_new", safety_check="passed"
   → 실패(throw):
     → fallback.select() → processing_path="fallback", safety_check="fallback", tokens=0
```

`latency_ms`는 `run()` 전체 wall-time이며, `estimated_cost_usd`는 `estimateCostUsd(model_used, prompt_tokens, completion_tokens)`로 산출한다. `model_used`가 null인 경로(cache/vector_exact/fallback)는 비용 0이다.

### Graceful Degradation 순서

1. **Redis 오류**: `cache.get()`/`cache.set()` 오류는 조용히 흡수. `get` 오류는 MISS로 취급해 retriever로 진행. `set` 오류는 `console.warn` 후 resolve.
2. **VectorDB/임베딩 오류**: retriever throw → `transformer.transform()` 직접 호출 + `safetyPipeline.apply()`.
3. **LLM 오류 또는 타임아웃**: retriever는 `Promise.race`로 10초 타임아웃 강제(retriever 자체는 백그라운드에서 계속 실행될 수 있음, PoC 트레이드오프). transformer 직접 호출 시에는 `AbortSignal.timeout(10_000)`을 실제 전달해 SDK 수준에서 취소. 두 경우 모두 최종 실패 시 `fallback.select()` 호출.

복구 경로(retriever 장애 후 transformer 직접 호출)에서 `safetyPipeline.apply()`가 blocked를 반환하면, safetyPipeline의 자체 fallback 퀘스트를 사용하지 않고 `fallback.select()`를 명시적으로 호출한다. 모든 fallback 경로의 메타 매핑을 일관성 있게 처리하기 위함이다.

### safety_check 매핑 (`mapFilter`)

| FilterResult 상태 | safety_check |
|---|---|
| `filter_result` undefined 또는 `verdict="safe"` | `"passed"` |
| `verdict="replaced"` | `"replaced"` |
| `blocked=true` | `"fallback"` |

`cache` / `vector_exact` 경로는 저장 시점에 SafetyFilterPipeline을 통과한 퀘스트만 저장됨을 전제로 `safety_check="passed"` 고정.

### 서버 기동 (`src/api/index.ts`)

조립 순서:

1. 환경변수 검증 (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
2. Anthropic / OpenAI / Supabase 클라이언트 생성
3. `EmbeddingService`, `VectorStore`, `LightModifier`, `QuestTransformer` 생성
4. `RuleFilter`, `LlmVerifier`, `FallbackSelector`, `SafetyFilterPipeline` 생성
5. `QuestRetriever` 생성
6. Redis 연결 시도 (`REDIS_URL` 환경변수, 기본 `redis://localhost:6379`). `lazyConnect: true`, `connectTimeout: 2_000ms`. 실패 시 `console.warn` 후 `cache=undefined`로 계속
7. `IntegratedPipeline({ retriever, transformer, fallback, cache, safetyPipeline })` 생성
8. `buildServer(transformer, pipeline)` → `listen(PORT, "0.0.0.0")`

`SIGINT`/`SIGTERM` 수신 시: `app.close()` → `redis.quit()` 순서로 graceful shutdown.

### E2E 평가 (`eval:integrated`)

`computeIntegratedMetrics(items)` 순수 함수로 경로별 건수, p95 지연, 총 비용, 건당 평균, G-1 판정을 계산한다. `runIntegratedEval`은 실제 인프라(Anthropic/OpenAI/Supabase/Redis)에 의존하는 CLI 전용 함수다.

```bash
npm run eval:integrated -- --limit=100 --output=data/evaluations/result.json
```

픽스처는 `data/habits/sample-50.json × 2 worldview` 조합에 부적절 습관 5건(builtin)을 추가해 fallback 경로 관측을 보장한다.

결과 JSON 스키마:

```json
{
  "runId": "integrated-run-<timestamp>",
  "completedAt": "<ISO 8601>",
  "items": [
    {
      "id": "h001-kingdom_of_light",
      "habit_text": "아침 8시에 일어나기",
      "worldview_id": "kingdom_of_light",
      "processing_path": "llm_new",
      "safety_check": "passed",
      "latency_ms": 1420,
      "estimated_cost_usd": 0.000244
    }
  ],
  "summary": {
    "path_distribution": { "cache": 10, "vector_exact": 30, "vector_modify": 20, "llm_new": 35, "fallback": 5 },
    "p95_by_path": { "cache": 15, "vector_exact": 180, "vector_modify": 2100, "llm_new": 3800, "fallback": 50 },
    "total_cost_usd": 0.045,
    "avg_cost_per_item": 0.00045,
    "g1_pass": true,
    "error_count": 0
  }
}
```

## 제약사항

### PoC 통과 기준

| 목표 | 측정 방법 | 통과 기준 |
|------|----------|-----------|
| G-1: 5개 경로 E2E 정상 동작 | 100건 일괄 변환 에러 0건 | 5개 경로 각 최소 1건 이상 관측 |
| G-2: 경로별 성능·비용 실측 | `eval:integrated` 결과 JSON | 경로별 p95 응답 시간 + 건당 비용 보고서 |
| G-3: MVP용 API 계약 확정 | PRD R-001 스키마 준수 | §PRD 계약 의도적 예외 목록 허용 |
| G-4: 장애 시나리오 Graceful Degradation | - | LLM 타임아웃 → fallback 100%; VectorDB 다운 → LLM 직접 또는 fallback; Redis 다운 → 캐시 스킵 후 유효 퀘스트 반환 |

### PRD 계약 의도적 예외

| 항목 | PRD 기준 | F-004 결정 | 근거 |
|------|---------|-----------|------|
| regenerate=true 변형 보장 | 반드시 다른 변형 반환 | best-effort (llm_new: nonce+temperature boost. vector 경로: 동일 결과 가능) | vector 경로에서 "다른 변형" 보장은 VectorDB 강제 우회가 필요해 PoC 범위 초과 |
| cache/vector_exact 안전 필터 | 모든 경로 응답 전 안전 필터 (PRD R-002) | 스킵. `safety_check="passed"` 고정 | 저장 시점에 SafetyFilter 통과 퀘스트만 저장됨. 재필터는 중복 비용 |

### 보안 제약

- `worldview_id`는 `/^[a-z0-9_-]+$/` 패턴만 허용 (경로 탐색 및 공백 주입 방지).
- `habit_text`는 최대 500자로 제한 (LLM 비용 및 DoS 방어).
- `character_context` 문자열 필드는 최대 100자, ASCII 제어 문자 금지 (프롬프트 인젝션 방지).
- CLI `--output`, `--fixtures` 인자에 `..` 세그먼트가 있으면 즉시 거부.
- Redis 연결 URL에 자격증명이 포함될 수 있으므로 에러 출력 시 `message`만 기록.
- 500 에러의 내부 원인은 클라이언트에 노출하지 않는다.

### Non-goals (PoC 범위 밖)

| 항목 | 사유 |
|------|------|
| 인증/인가 (Firebase Auth) | MVP에서 구현 |
| Rate limiting | MVP에서 구현 |
| 프로덕션 배포 인프라 | PoC는 로컬/dev 서버 |
| LLM 응답 스트리밍 | MVP에서 구현 |
| `/api/quest/transform` 스키마 변경 | F-001 계약 유지 |
| Redis 캐시 자동 무효화 | 수동 클리어로 충분 (PoC 기간) |
| 배치 API (`/api/quest/generate/batch`) | 별도 토픽으로 분리 |
| regenerate=true에서 vector 경로 강제 우회 | PoC 범위 초과 |
| character_context 없는 요청과의 캐시 공유 | 보안 리뷰 후 character_context 포함 키로 확정 |

## 관련 문서

- F-001 스펙: `docs/specs/f001-llm-engine.md`
- F-002 스펙: `docs/specs/f002-vector-db.md`
- F-003 스펙: `docs/specs/f003-safety-filter.md`
- PRD: `prd/prd-f004-integrated-api.md`
