---
last_modified: 2026-04-22
author: @mario
status: Active
---

# F-002 Vector DB 퀘스트 재활용 시스템

> F-001 LLM 엔진 위에 Supabase pgvector 기반 3단계 재활용 체인을 추가하여 유사 습관 입력 시 LLM 호출 없이 기존 퀘스트를 반환하거나 경량 수정하는 PoC.

## 개요

`POST /api/quest/generate` 엔드포인트가 습관 텍스트를 받으면 OpenAI text-embedding-3-small로 임베딩을 생성하고 Supabase pgvector RPC로 코사인 유사도 상위 후보를 검색해 경로를 분기한다.

- **vector_exact** (sim ≥ 0.9): 기존 퀘스트를 그대로 반환. LLM 호출 없음.
- **vector_modify** (0.7 ≤ sim < 0.9): Anthropic Claude로 기존 퀘스트를 경량 수정.
- **llm_new** (sim < 0.7): F-001 파이프라인으로 신규 생성 후 Vector DB에 자동 저장.

**기술 스택**: TypeScript + Fastify 5 + @supabase/supabase-js + OpenAI SDK + @anthropic-ai/sdk + Zod + Vitest. F-001과 동일한 스택이며 LangChain은 사용하지 않는다.

**PoC 검증 목표**:

| 목표 | 기준 |
|------|------|
| G-1: 유사 습관 매칭률 | 유사 습관 100건 기준 유사도 0.7+ 매칭률 ≥ 60% |
| G-2: 검색 응답 속도 | vector_exact 경로 평균 < 200ms |
| G-3: 의도 보존율 | 유사도 ≥ 0.9 재활용 퀘스트의 category 일치율 ≥ 85% |
| G-4: 임계값 트레이드오프 | 0.7 / 0.8 / 0.9 구간별 품질·속도 비교 리포트 |

## 구조 / 스키마

### 디렉토리 구조

```
src/
├── api/
│   ├── server.ts                    /api/quest/generate 라우트 추가 (기존 /transform 유지)
│   └── index.ts                     QuestRetriever 조립 및 buildServer 확장
├── core/
│   ├── retriever.ts                 QuestRetriever (3단계 체인 오케스트레이터)
│   ├── modifier.ts                  LightModifier (0.7~0.9 구간 경량 수정)
│   ├── vector/
│   │   ├── embedding.ts             EmbeddingService (OpenAI text-embedding-3-small)
│   │   └── store.ts                 VectorStore (Supabase RPC 저장·검색)
│   ├── schemas/
│   │   └── api.ts                   GenerateRequestSchema / GenerateResponseSchema 추가
│   └── prompt/
│       └── strip-code-fence.ts      코드펜스 제거 유틸 (transformer.ts와 공유)
└── eval/
    └── match-runner.ts              매칭 평가 러너 (eval:match)

src/scripts/
├── seed-vectors.ts                  Vector DB 시드 적재 CLI (seed:vectors)
└── README.md                        사전 조건 및 실행 절차

supabase/migrations/
├── 20260421_001_quest_vectors.sql   quest_vectors 테이블 + match_quest_vectors RPC
├── 20260421_002_add_is_seed_to_rpc.sql  match_quest_vectors RPC에 is_seed 컬럼 추가 (F-003)
└── README.md                        수동 적용 절차 및 롤백 스니펫

data/
├── habits/
│   ├── sample-50.json               F-001 평가용 습관 샘플 (기존)
│   └── similar-100.json             F-002 매칭 평가용 유사 습관 100건 (expectedHabitCategory 포함)
└── evaluations/                     eval:run 결과 JSON (시드 소스)

tests/
├── core/vector/                     EmbeddingService, VectorStore 단위 테스트
├── core/modifier.test.ts            LightModifier 단위 테스트
├── core/retriever.test.ts           QuestRetriever 경계값 포함 6개+ 케이스
├── api/generate.test.ts             /api/quest/generate 통합 테스트
└── eval/match-runner.smoke.test.ts  3건 모킹으로 경로별 카운트·intentPreservationRate 검증
```

### Vector DB 스키마 (quest_vectors)

```sql
CREATE TABLE quest_vectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worldview_id  TEXT NOT NULL,
  age_group     TEXT NOT NULL,
  input_text    TEXT NOT NULL,
  embedding     vector(1536),
  quest_result  JSONB NOT NULL,
  is_seed       BOOLEAN DEFAULT false,
  usage_count   INTEGER DEFAULT 0,
  quality_score FLOAT DEFAULT 0.0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

| 필드 | 설명 |
|------|------|
| `embedding` | OpenAI text-embedding-3-small 1536차원 벡터 |
| `quest_result` | F-001 QuestSchema JSONB |
| `is_seed` | F-001 eval:run 결과로 적재된 시드 데이터 여부 |
| `quality_score` | MVP에서 피드백 루프 구현 시 사용. PoC에서는 0.0 고정 |

인덱스: `idx_quest_vectors_embedding` (ivfflat, vector_cosine_ops), `idx_quest_vectors_filter` (worldview_id, age_group).

### match_quest_vectors RPC

```sql
match_quest_vectors(
  query_embedding       vector(1536),
  filter_worldview_id   text,
  filter_age_group      text,
  match_count           int DEFAULT 5
) RETURNS TABLE (id, input_text, quest_result, similarity, is_seed)
```

코사인 유사도 `1 - (embedding <=> query)` 기준 내림차순 상위 `match_count`개를 반환한다.

### 핵심 타입

```typescript
export type RoutingPath = "vector_exact" | "vector_modify" | "llm_new"

export interface RetrieveMeta {
  path: RoutingPath
  similarity: number | null   // llm_new 경로(후보 없음)는 null
  latency_ms: number
  filter_result?: FilterResult  // F-003: SafetyFilterPipeline 결과 (미주입 시 undefined)
}

export interface SearchHit {
  id: string
  inputText: string
  quest: Quest
  similarity: number
  is_seed: boolean        // F-003: FallbackSelector seed 필터링용
}
```

## 동작

### API

```
POST /api/quest/generate
Content-Type: application/json
```

**요청 필드**:

| 필드 | 타입 | 필수 | 제약 |
|------|------|------|------|
| `habit_text` | `string` | 필수 | 1-500자 |
| `worldview_id` | `string` | 필수 | `/^[a-z0-9_-]+$/` |
| `age_group` | `string` | 선택 | 기본값 `"7-12"`, 형식 `^\d{1,2}-\d{1,2}$` |

**응답 (200)**:

```json
{
  "quest": { /* QuestSchema (F-001 동일) */ },
  "meta": {
    "path": "vector_exact" | "vector_modify" | "llm_new",
    "similarity": 0.94,
    "latency_ms": 120
  }
}
```

`similarity`는 llm_new 경로에서 후보가 없으면 `null`이다.

**에러 응답**:

| 상태 코드 | 조건 |
|-----------|------|
| `400` | 입력 검증 실패 (habit_text 길이, worldview_id 형식 위반) |
| `422` | LLM 응답 파싱 실패 또는 Quest 스키마 검증 실패 |
| `500` | 그 외 내부 오류 (원인 미노출) |

기존 `POST /api/quest/transform`은 변경하지 않으며 계속 동작한다.

### 처리 흐름

```
POST /api/quest/generate
  │
  ├─ 1. Zod로 요청 body 검증 → 실패 시 400
  ├─ 2. EmbeddingService.embed(habit_text) — 1536차원 벡터 생성
  ├─ 3. VectorStore.search({ embedding, worldviewId, ageGroup }) — RPC 호출
  │
  ├─ sim ≥ 0.9  → path: "vector_exact"  — 기존 quest 그대로 반환
  ├─ 0.7 ≤ sim < 0.9 → path: "vector_modify"
  │    └─ LightModifier.modify({ habitText, worldviewId, ageGroup, baseQuest })
  │         — Anthropic API로 퀘스트 경량 수정
  └─ sim < 0.7  → path: "llm_new"
       ├─ QuestTransformer.transform(req)  — F-001 파이프라인
       └─ VectorStore.save({ ..., isSeed: false })  — 임베딩 재사용, 저장 실패 시 로그만 기록
```

`vector_modify` 경로의 결과는 Vector DB에 저장하지 않는다. `llm_new` 경로에서만 저장이 발생한다.

`LightModifier`는 기존 퀘스트 전체를 컨텍스트로 전달하고, F-001 QuestTransformer와 동일하게 `original_habit`·`worldview_id`를 요청값으로 강제 주입한 뒤 QuestSchema.safeParse로 검증한다.

### 컴포넌트 조립 (src/api/index.ts)

```typescript
buildServer({
  transformer: new QuestTransformer(anthropicClient, model),
  retriever: new QuestRetriever({
    embedding: new EmbeddingService(openaiClient, embeddingModel),
    store: new VectorStore(supabaseClient),
    modifier: new LightModifier(anthropicClient, model),
    transformer,
    thresholds: { exact: 0.9, modify: 0.7 }  // 기본값
  })
})
```

`retriever`가 주입된 경우에만 `/api/quest/generate` 라우트가 등록된다.

### CLI 도구

**seed:vectors** (`src/scripts/seed-vectors.ts`):

F-001 `data/evaluations/run-*.json`을 읽어 `quest !== null`인 항목을 `is_seed=true`로 Vector DB에 적재한다.

```
npm run seed:vectors -- --input=data/evaluations/run-<timestamp>.json
npm run seed:vectors -- --input=<path> --dry-run   # 네트워크 호출 없이 카운트만 출력
```

**eval:match** (`src/eval/match-runner.ts`):

`data/habits/similar-100.json`을 QuestRetriever에 통과시켜 경로별 분포, 지연, 의도 보존율을 수치화한다.

```
npm run eval:match -- --thresholds=0.7,0.8,0.9 --output=/tmp/f002-match.json
```

출력 JSON은 threshold별 블록 배열이며 각 블록에 `matchRate_0_7`, `avgLatencyMs`, `p95LatencyMs`, `intentPreservationRate` 필드를 포함한다. 콘솔에 G-1/G-2/G-3 PASS/FAIL 요약 표를 출력한다.

## 제약사항

### PoC 범위 밖

- **Redis 정확 매칭 캐시**: vector_exact(sim ≥ 0.9)가 동등한 속도 이점을 제공한다. Redis 인프라는 MVP에서 추가한다.
- **인증 및 속도 제한**: 엔드포인트에 인증/rate-limiting이 없다. 프로덕션 적용 전 추가 필요.
- **프로덕션 인프라**: Pinecone, Qdrant 클러스터 비교는 Supabase pgvector 한계 확인 후 MVP에서 결정한다.
- **변형 풀 로테이션**: 동일 습관에 3~5개 변형을 축적하는 다양성 전략은 MVP로 이연.
- **품질 점수 기반 자동 갱신**: `quality_score` 필드는 예약 상태이며 PoC에서는 0.0 고정.
- **임베딩 모델 비교**: text-embedding-3-small로 고정. 한국어 특화 모델(KoSimCSE 등) 비교는 MVP.

### 기능 제약

- ivfflat 인덱스는 40~100건 규모에서 브루트포스 대비 이점이 없을 수 있다. `lists=100` 기본값이며 벤치마크 후 조정 가능.
- 마이그레이션 SQL은 Supabase SQL Editor 또는 `psql`로 수동 적용해야 한다. 자동 마이그레이션 도구는 사용하지 않는다.
- `similar-100.json` 시드 데이터의 `expectedHabitCategory` 정답 레이블은 수동 작성이다.
- `seed:vectors` 재실행 시 중복 삽입이 발생한다. 재실행 전 `TRUNCATE quest_vectors WHERE is_seed=true` 절차는 `supabase/migrations/README.md`에 기록되어 있다.
