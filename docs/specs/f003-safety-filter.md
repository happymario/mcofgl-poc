---
last_modified: 2026-04-22
author: @mario
status: Active
---

# F-003 안전 필터 시스템

> F-002 QuestRetriever의 llm_new/vector_modify 출력 경로에 룰 기반 + LLM 후처리 2단계 안전 필터를 주입하여 아동(7~12세) 대상 퀘스트의 부적절 표현을 자동 차단하고, 차단 시 시드 퀘스트 기반 폴백으로 대체하는 PoC.

## 개요

`SafetyFilterPipeline`은 QuestRetriever에 선택적으로 주입되며, llm_new 및 vector_modify 경로의 퀘스트 출력을 2단계로 검사한다. 1단계 RuleFilter는 키워드·정규식 매칭으로 명백한 부적절 표현을 즉시 차단하고, 2단계 LlmVerifier는 Claude Haiku로 경계선 표현을 추가 판정한다. 차단 판정 시 FallbackSelector가 `is_seed=true` 퀘스트를 유사도 검색으로 찾아 대체하며, 실패 시 코드 내장 빌트인 퀘스트를 반환한다.

기존 `/api/quest/generate` 엔드포인트 계약은 변경하지 않는다. 필터 결과는 응답 `meta.filter_result` 선택 필드로 노출된다.

**PoC 검증 목표**:

| # | 목표 | 기준 |
|---|------|------|
| G-1 | 부적절 표현 100% 차단 | 엣지 케이스 30건 → 통과율 0% |
| G-2 | 정상 퀘스트 오차단율 ≤ 2% | 정상 퀘스트 50건 → 오차단 최대 1건 |
| G-3 | 폴백 시스템 정상 동작 | 차단 시 is_seed=true 퀘스트로 대체 |
| G-4 | 필터 응답 시간 | 룰 기반 p95 < 10ms, LLM 검증 p95 < 500ms, 합산 p95 < 600ms |

## 구조 / 스키마

### 디렉토리 구조

```
src/
├── core/
│   ├── safety/
│   │   ├── schemas.ts             Zod 스키마 (SafetyRulesSchema, SafetyFixtureItemSchema)
│   │   ├── load-safety-rules.ts   safety-rules.json 로더 (Map 캐시 + 정규식 컴파일 검증)
│   │   ├── rule-filter.ts         1차: 룰 기반 필터 (키워드/정규식, reward.buff 포함)
│   │   ├── llm-verifier.ts        2차: LLM 안전성 검증 (Claude Haiku, 4000ms timeout)
│   │   ├── fallback-quests.ts     빌트인 범용 퀘스트 상수 (세계관별 1건)
│   │   ├── fallback-selector.ts   폴백: is_seed=true 유사도 검색 → 빌트인 폴백
│   │   └── pipeline.ts            SafetyFilterPipeline (체인 오케스트레이터)
│   ├── retriever.ts               QuestRetriever — safetyPipeline 선택적 주입 (F-003)
│   └── schemas/
│       └── api.ts                 FilterResultSchema 추가, GenerateResponseMeta에 filter_result 추가
├── eval/
│   └── safety-runner.ts           eval:safety CLI (computeSafetyMetrics 순수 함수 포함)
└── api/
    └── index.ts                   부트스트랩: SafetyFilterPipeline 조립 및 QuestRetriever에 주입

data/
├── safety-rules.json              차단 키워드·패턴·allowlist 설정 파일
└── evaluations/
    └── safety-fixtures/
        ├── edge-cases-30.json     부적절 표현 30건 (expected_block=true)
        └── normal-habits-50.json  정상 습관 50건 (expected_block=false)

supabase/migrations/
└── 20260421_002_add_is_seed_to_rpc.sql  match_quest_vectors RPC에 is_seed 컬럼 추가

tests/
└── core/safety/                   RuleFilter, LlmVerifier, FallbackSelector, Pipeline 단위 테스트
```

### safety-rules.json 구조

`data/safety-rules.json`은 코드 배포 없이 규칙을 업데이트할 수 있는 외부 설정 파일이다.

```json
{
  "categories": {
    "violence": {
      "keywords": ["살인", "죽여", "때려", "칼로", "폭발", "폭력", "공격해", "부숴", "박살"],
      "patterns": ["\\d+명.*죽"],
      "action": "block_and_fallback"
    },
    "negative_emotion": {
      "keywords": ["자살", "죽고 싶어", "사라지고 싶어", "무가치", "쓸모없어"],
      "action": "block_and_fallback"
    },
    "fear": {
      "keywords": ["악몽", "납치", "고문", "공포에 떨게", "겁나서 도망"],
      "action": "block_and_fallback"
    },
    "sexual": {
      "keywords": ["야한", "성관계", "섹스", "포르노"],
      "action": "block_and_fallback"
    }
  },
  "allowlist": ["어둠의 안개", "몬스터", "어둠", "마왕", "용사", "전투", "마법", "마나"]
}
```

카테고리 액션은 두 종류다:

| 액션 | 동작 |
|------|------|
| `block_and_fallback` | 즉시 차단 → FallbackSelector 호출 (LlmVerifier 스킵) |
| `replace` | 키워드를 지정 대체어로 치환 → 즉시 반환 (LlmVerifier 스킵). 치환 매핑은 사전 검증된 안전 표현을 사용하므로 추가 LLM 검증이 불필요하다. |

`allowlist`는 RPG 세계관 내 허용 표현 목록이다. RuleFilter가 매칭 전에 allowlist 항목을 길이 내림차순으로 제거해 "어둠의 안개"가 "어둠"보다 먼저 제거되도록 보장한다.

`load-safety-rules.ts`는 파일을 로딩할 때 `patterns` 필드의 정규식을 `new RegExp()`으로 컴파일 검증하며, 동일 `baseDir`에 대한 반복 호출은 Map 캐시로 같은 참조를 재사용한다.

### FilterResult 타입

`src/core/schemas/api.ts`에서 `FilterResultSchema`로 정의한다.

```typescript
export interface FilterResult {
  stage: "rule" | "llm"       // 차단/통과 판정이 발생한 단계
  verdict: "safe" | "unsafe" | "borderline" | "replaced"
  blocked: boolean
  latency_ms: number          // SafetyFilterPipeline.apply() 전체 wall-time
  rule_latency_ms?: number    // RuleFilter.check() 지연 (항상 측정)
  llm_latency_ms?: number     // LlmVerifier.verify() 지연 (LLM 호출 경로만)
}
```

`filter_result`는 `GenerateResponseMeta`에 선택적 필드로 추가된다. 필터가 주입되지 않은 경우(`vector_exact` 경로 또는 safetyPipeline 미주입) `undefined`이다.

## 동작

### 필터 파이프라인

`SafetyFilterPipeline.apply()`의 처리 흐름:

```
입력: Quest (llm_new 또는 vector_modify 경로 출력)
  │
  ├─ ① RuleFilter.check(quest)
  │   검사 대상: quest_name + description + reward.buff (allowlist 항목 제거 후 매칭)
  │
  │   block_and_fallback 판정
  │   → stage="rule", verdict="unsafe", blocked=true
  │   → FallbackSelector 즉시 호출 (LlmVerifier 스킵)
  │
  │   replaced 판정 (description 키워드 치환)
  │   → stage="rule", verdict="replaced", blocked=false (LlmVerifier 스킵)
  │   → 치환 매핑은 사전 검증된 안전 표현이므로 추가 LLM 검증 불필요
  │
  │   pass 판정
  │   → 원본 quest로 LlmVerifier 진입
  │
  └─ ② LlmVerifier.verify(quest, ageGroup)  ← pass 경로만 진입
      모델: claude-haiku-4-5-20251001, MAX_TOKENS=128, timeout=4000ms
      판정 기준: 폭력·공포·부정감정·성적 표현 + 경쟁 심리·약점 공략·적대적 행동 → unsafe
                 RPG 세계관의 일반적 전투 표현(몬스터 처치 등) → safe

      safe → stage="llm", verdict="safe", blocked=false

      unsafe   → stage="llm", verdict="unsafe",    blocked=true → FallbackSelector
      borderline → stage="llm", verdict="borderline", blocked=true → FallbackSelector
                   (console.warn 로그 기록 — 운영 모니터링 대상)
```

LlmVerifier는 어떤 단계에서든 실패하면 fail-closed로 `verdict="unsafe"`를 반환한다. 이는 4000ms SDK timeout 초과 포함 모든 예외에 적용된다.

### 폴백 알고리즘

`FallbackSelector.select()`의 2단계 알고리즘:

1. `EmbeddingService.embed(habitText)`로 현재 요청 텍스트를 임베딩하고, `VectorStore.search(worldviewId, ageGroup)`으로 유사도 상위 N건을 조회한다. 결과 배열에서 `is_seed=true`인 첫 번째 항목(유사도 최상위)의 quest를 반환한다.

2. `is_seed=true` 히트가 없거나, 임베딩·검색 단계에서 예외가 발생하면 코드 내장 빌트인 범용 퀘스트를 반환한다(`getBuiltinFallbackQuest(worldviewId, habitText)`). PoC는 `kingdom_of_light`, `starlight_magic_school` 2개 세계관의 빌트인 퀘스트를 인라인 상수로 관리한다.

알 수 없는 `worldview_id`가 빌트인 조회 시 발생하면 `Error`를 throw한다(fail-closed). 임베딩·검색 예외는 내부적으로 삼키고 빌트인으로 넘어간다(fail-open to builtin).

폴백 퀘스트에는 항상 현재 요청의 `original_habit`과 `worldview_id`가 강제 주입된다.

### 경로 적용 범위

| 경로 | 안전 필터 적용 | Vector DB 저장 |
|------|--------------|----------------|
| `llm_new` | 적용 | 필터 통과(`blocked=false`)일 때만 저장. 차단 시 저장 스킵 |
| `vector_modify` | 적용 | 저장 없음 (F-002 기존 동작 동일) |
| `vector_exact` | 미적용 | 해당 없음 (기존 저장 퀘스트 재사용) |

`safetyPipeline`이 주입되지 않은 경우 F-002와 동일하게 동작한다(하위 호환).

### 부트스트랩 조립 (src/api/index.ts)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` 3개 환경변수가 모두 설정된 경우에만 `SafetyFilterPipeline`이 조립되어 `QuestRetriever`에 주입된다.

```typescript
const safetyRules = loadSafetyRules()
const ruleFilter = new RuleFilter(safetyRules)
const llmVerifier = new LlmVerifier(anthropic, haikuModel)
const fallbackSelector = new FallbackSelector(embedding, store)
const safetyPipeline = new SafetyFilterPipeline(ruleFilter, llmVerifier, fallbackSelector)

new QuestRetriever({ embedding, store, modifier, transformer, safetyPipeline })
```

### eval:safety CLI

`src/eval/safety-runner.ts`가 `eval:safety` npm 스크립트로 실행된다.

```
npm run eval:safety -- --worldview=kingdom_of_light --output=/tmp/safety-run.json
npm run eval:safety -- --limit=5   # 각 그룹당 5건으로 제한
```

**CLI 인자**:

| 인자 | 기본값 | 설명 |
|------|--------|------|
| `--worldview` | `kingdom_of_light` | 평가 대상 세계관 |
| `--output` | `data/evaluations/safety-run-<timestamp>.json` | 결과 저장 경로 |
| `--limit` | `0` (전체) | 각 그룹당 항목 수 상한 |
| `--fixtures-dir` | `data/evaluations/safety-fixtures` | 픽스처 디렉터리 |

`computeSafetyMetrics(edgeItems, normalItems)`는 순수 함수로 분리되어 단위 테스트 대상이다. G-1/G-2/G-4 지표를 한 번에 산출한다:

| 지표 | 계산 |
|------|------|
| `edge_passing_rate` | (expected_block=true && actual_blocked=false) / edge_total |
| `normal_false_block_rate` | (expected_block=false && actual_blocked=true) / normal_total |
| `p95_rule_ms` | stage="rule" 항목의 latency_ms p95 |
| `p95_llm_ms` | stage="llm" 항목의 latency_ms p95 |
| `p95_total_ms` | 전체 항목의 latency_ms p95 |
| `g1_pass` | edge_passing_rate === 0 |
| `g2_pass` | normal_false_block_rate <= 0.02 |
| `g4_pass` | p95_rule_ms < 10 && p95_llm_ms < 500 && p95_total_ms < 600 |

`ANTHROPIC_API_KEY`는 필수 환경변수다. `OPENAI_API_KEY`·`SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY`가 없으면 FallbackSelector가 빈 검색 결과를 반환해 빌트인 폴백만 사용한다.

파이프라인 예외는 보수적으로 `actual_blocked=true`로 기록한다(fail-closed와 동일).

## 제약사항

### PoC 범위 밖

- **ML 기반 분류 모델**: PoC는 룰 + LLM 검증으로 충분. MVP에서 구현.
- **부모 입력 텍스트 필터링**: 부모 입력은 아이에게 직접 노출되지 않음.
- **런타임 규칙 추가 API**: JSON 파일 재배포로 대응. PoC 범위 밖.
- **차단 통계 대시보드 / 실시간 모니터링**: 운영 도구. MVP 구현.
- **borderline 수동 검토 파이프라인**: console.warn 로그 기록만. MVP에서 정의.
- **다국어 필터**: 현재 한국어만.
- **replace 카테고리의 patterns**: 현재 스펙상 치환 매핑이 정의되지 않아 처리하지 않음. 필요 시 테스트와 함께 추가.

### 알려진 동작 제약

- LlmVerifier SDK timeout은 4000ms (하드 상한)이며, G-4 목표치(p95 < 500ms)와 별개다. timeout 초과 시 fail-closed로 `verdict="unsafe"` 처리된다.
- `safety-rules.json`의 `replace` 카테고리는 현재 전부 `block_and_fallback` 액션이다. `replace` 액션 지원 코드는 구현되어 있으나 실제 규칙에서 미사용 중이다.
- 빌트인 폴백 퀘스트는 PoC 2개 세계관(`kingdom_of_light`, `starlight_magic_school`)만 지원한다. 새 세계관 추가 시 `fallback-quests.ts`에 상수 추가 필요.
- `seed:vectors` 재실행 시 중복 `is_seed=true` 행이 삽입될 수 있다. FallbackSelector는 유사도 최상위 seed 1건만 사용하므로 동작에 영향은 없다.
