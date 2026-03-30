# PRD: F-002 Vector DB 퀘스트 재활용 시스템

> **문서 버전:** 0.1 · **작성일:** 2026.03.23 · **작성자:** Mario
> **PoC 피처:** F-002 · **검증 가설:** H-3
> **의존성:** F-001 (LLM 엔진의 변환 결과를 저장/검색)
> **참조:** [blueprint/llm-engine.md](../blueprint/llm-engine.md) §5, [blueprint/decisions.md](../blueprint/decisions.md) D-014

---

## 1. 문제 정의

습관의 종류는 유한하다. "아침 8시에 일어나기"와 "매일 아침 7시 반에 기상"은 본질적으로 같은 습관이다. 매번 LLM을 호출하면 비용이 선형 증가하고 응답 속도도 느려진다. 기존에 생성한 퀘스트를 Vector DB에 저장하고, 유사한 습관이 입력되면 기존 결과를 재활용해야 한다.

이 시스템이 동작해야 서비스 성숙기에 LLM 호출률을 5~10%까지 낮출 수 있고, 건당 < 200ms의 응답 속도를 달성할 수 있다. 비용 구조의 지속 가능성이 이 피처에 달려 있다.

---

## 2. 목표

| # | 목표 | 측정 방법 |
|---|------|----------|
| G-1 | 유사 습관 입력 시 기존 퀘스트를 정확히 매칭하여 재활용할 수 있음을 검증한다 | 유사 습관 100건 테스트 → 유사도 0.7+ 매칭률 60% 이상 |
| G-2 | Vector DB 검색이 LLM 호출 대비 유의미하게 빠름을 확인한다 | Vector DB 응답 시간 < 200ms (LLM 대비 10배+ 개선) |
| G-3 | 재활용된 퀘스트의 품질이 신규 생성과 동등함을 확인한다 | 재활용 퀘스트의 품질 평가 합격률 ≥ F-001 기준 |
| G-4 | 유사도 임계값별 처리 전략(그대로/수정/신규)의 적정값을 탐색한다 | 0.7, 0.8, 0.9 구간별 품질·속도·비용 트레이드오프 분석 |

---

## 3. 비목표 (Non-Goals)

| # | 비목표 | 사유 |
|---|--------|------|
| NG-1 | 프로덕션 수준의 Vector DB 인프라 (Pinecone, Qdrant 클러스터) | PoC는 Supabase pgvector로 충분. 스케일 이슈 발생 시 MVP에서 결정 |
| NG-2 | 다양성 확보 전략 (변형 풀 로테이션, 시즌 바리에이션) | 재활용 체인의 기본 동작을 먼저 검증. 다양성은 MVP |
| NG-3 | 품질 점수 기반 자동 갱신 | 사용 횟수, 부모 승인율 등 품질 피드백 루프는 MVP |
| NG-4 | 보상 벤치마크 집계 (D-015) | Vector DB 인프라를 공유하지만 별도 기능. MVP P1 |
| NG-5 | 실시간 임베딩 모델 최적화 | PoC는 text-embedding-3-small 고정. 모델 비교는 MVP |

---

## 4. 사용자 스토리

### 시스템 (내부)

- **US-001:** 시스템으로서, "아침 8시 기상"이 입력되면 이전에 "매일 아침 7시 반에 일어나기"로 생성된 퀘스트를 찾아 즉시 반환하고 싶다. 그래야 LLM을 호출하지 않아도 된다.
- **US-002:** 시스템으로서, 유사도가 높지만 완전히 같지 않은 습관(0.7~0.9)에는 기존 퀘스트를 기반으로 LLM이 미세 조정만 하게 하고 싶다. 그래야 비용과 품질을 둘 다 잡을 수 있다.
- **US-003:** 시스템으로서, 완전히 새로운 유형의 습관(< 0.7)이 입력되면 LLM으로 신규 생성하고, 결과를 Vector DB에 자동 저장하고 싶다. 그래야 다음에는 재활용할 수 있다.

### 부모 (간접)

- **US-004:** 부모로서, 습관을 입력하면 빠르게(2초 이내) 퀘스트 미리보기를 받고 싶다. 기다리는 시간이 길면 불편하다.

---

## 5. 요구사항

### 5.1 Must-Have (P0)

#### R-001. 임베딩 및 저장

부모 입력 텍스트를 벡터로 변환하여 Vector DB에 저장한다.

**인수 기준:**

- [ ] 습관 텍스트를 임베딩 모델(text-embedding-3-small)로 벡터 변환한다
- [ ] 변환 결과와 메타데이터를 Vector DB에 저장한다
- [ ] 저장 스키마: 입력 임베딩, 세계관 ID, 연령 그룹, 퀘스트 결과 JSON, 원본 입력, 생성 일시

#### R-002. 유사도 검색

입력 습관과 가장 유사한 기존 퀘스트를 검색한다.

**인수 기준:**

- [ ] 입력 텍스트의 임베딩과 코사인 유사도 기준으로 상위 N개(기본 3개) 결과를 반환한다
- [ ] 검색 시 세계관 ID와 연령 그룹으로 필터링한다 (다른 세계관의 퀘스트가 매칭되지 않도록)
- [ ] 검색 응답 시간 < 200ms (40건 시드 기준)

#### R-003. 3단계 처리 체인

유사도 구간에 따라 다른 처리를 적용한다.

```
① 정확 매칭 (Redis 캐시) → 동일 텍스트 → 즉시 반환
② Vector DB 유사도 ≥ 0.9 → 기존 퀘스트 그대로 반환
③ Vector DB 유사도 0.7~0.9 → 기존 퀘스트 + LLM 경량 수정
④ Vector DB 유사도 < 0.7 → LLM 신규 생성 → 결과 자동 저장
```

**인수 기준:**

- [ ] 정확 매칭 시 LLM 호출 없이 < 10ms 내 반환한다
- [ ] 유사도 ≥ 0.9 시 LLM 호출 없이 기존 결과를 반환한다
- [ ] 유사도 0.7~0.9 시 기존 퀘스트를 컨텍스트로 LLM에 전달하여 미세 수정한다
- [ ] 유사도 < 0.7 시 F-001 파이프라인으로 신규 생성하고, 결과를 Vector DB에 자동 저장한다
- [ ] 응답에 처리 경로(cache/vector_exact/vector_modify/llm_new)와 유사도 점수를 메타로 포함한다

#### R-004. 초기 시드 데이터 로딩

F-001에서 사전 생성한 40건의 퀘스트를 Vector DB에 시드 데이터로 적재한다.

**인수 기준:**

- [ ] 사전 생성 퀘스트 40건이 임베딩과 함께 Vector DB에 적재된다
- [ ] 적재 후 유사 습관 검색이 정상 동작한다

### 5.2 Nice-to-Have (P1)

#### R-005. 임계값 실험 프레임워크

유사도 임계값(현재 0.7, 0.9)을 쉽게 조정하여 품질·속도·비용 트레이드오프를 탐색할 수 있다.

**인수 기준:**

- [ ] 임계값을 설정 파일에서 변경 가능하다
- [ ] 동일 테스트 세트에 대해 임계값별 결과 비교 리포트를 생성한다

#### R-006. 경량 수정 프롬프트 최적화

0.7~0.9 구간에서 LLM에 기존 퀘스트를 베이스로 전달하여 수정 범위를 최소화한다.

**인수 기준:**

- [ ] 경량 수정 시 LLM 응답 시간이 신규 생성 대비 50% 이하다
- [ ] 수정 결과가 원본 퀘스트의 톤을 유지하면서 새 습관의 의도를 반영한다

### 5.3 Future Considerations (P2)

| 항목 | 설명 | 현재 대응 |
|------|------|----------|
| 변형 풀 로테이션 | 같은 습관에 3~5개 변형 퀘스트 축적, 랜덤 제공 | 스키마에 variation_group 필드 예약 |
| 품질 점수 반영 | 부모 승인율, 수정 없이 사용된 비율 → 품질 가중치 | 스키마에 quality_score 필드 예약 |
| 클리어율 기반 갱신 | 클리어율 낮은 퀘스트 자동 교체 | MVP에서 행동 데이터 수집 후 구현 |
| Pinecone/Qdrant 마이그레이션 | 프로덕션 규모 대응 | PoC에서 pgvector 한계를 확인한 후 결정 |

---

## 6. 기술 명세

### 6.1 Vector DB 저장 스키마 (Supabase)

Supabase 대시보드 또는 SQL Editor에서 pgvector 확장을 활성화하고 테이블을 생성한다.

```sql
-- Supabase SQL Editor에서 실행
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE quest_vectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worldview_id  VARCHAR(50) NOT NULL,
  age_group     VARCHAR(10) NOT NULL,
  input_text    TEXT NOT NULL,
  embedding     vector(1536),         -- text-embedding-3-small 차원
  quest_result  JSONB NOT NULL,       -- F-001 출력 스키마
  is_seed       BOOLEAN DEFAULT false, -- 사전 생성 퀘스트 여부 (폴백용)
  usage_count   INTEGER DEFAULT 0,
  quality_score FLOAT DEFAULT 0.0,    -- P2 예약
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_quest_vectors_embedding
  ON quest_vectors USING ivfflat (embedding vector_cosine_ops);
```

### 6.2 유사도 검색 RPC (Supabase Function)

SupabaseVectorStore가 사용할 RPC 함수를 생성한다. 메타데이터 필터링(세계관, 연령)을 지원한다.

```sql
CREATE OR REPLACE FUNCTION match_quest_vectors(
  query_embedding vector(1536),
  match_count INT DEFAULT 3,
  filter_worldview VARCHAR DEFAULT NULL,
  filter_age_group VARCHAR DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  input_text TEXT,
  quest_result JSONB,
  is_seed BOOLEAN,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    qv.id,
    qv.input_text,
    qv.quest_result,
    qv.is_seed,
    1 - (qv.embedding <=> query_embedding) AS similarity
  FROM quest_vectors qv
  WHERE (filter_worldview IS NULL OR qv.worldview_id = filter_worldview)
    AND (filter_age_group IS NULL OR qv.age_group = filter_age_group)
  ORDER BY qv.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

> **참고:** SupabaseVectorStore는 내부적으로 이 RPC를 호출하여 유사도 검색을 수행한다. LangChain 코드에서는 `similaritySearchWithScore()`를 호출하면 된다.

### 6.3 처리 흐름

```
입력: habit_text, worldview_id, age_group
  │
  ├─ ① Redis 정확 매칭 (key = hash(habit_text + worldview_id + age_group))
  │    → HIT: 반환 {path: "cache", latency: ~5ms}
  │
  ├─ ② Vector DB 검색 (상위 1개의 유사도 확인)
  │    → sim ≥ 0.9: 반환 {path: "vector_exact", similarity, latency: ~100ms}
  │    → 0.7 ≤ sim < 0.9: LLM 경량 수정 {path: "vector_modify", similarity}
  │    → sim < 0.7: ③으로
  │
  └─ ③ LLM 신규 생성 (F-001 파이프라인)
       → 결과를 Vector DB + Redis에 저장
       → 반환 {path: "llm_new", latency: ~2000ms}
```

### 6.4 기술 스택 (PoC)

| 레이어 | 선택 | 사유 |
|--------|------|------|
| Vector DB | Supabase (PostgreSQL + pgvector) | pgvector 확장 기본 제공, 호스티드 DB로 인프라 셋업 최소화 |
| Vector DB 클라이언트 | SupabaseVectorStore (@langchain/community) + @supabase/supabase-js | LangChain 체인과 자연스러운 통합, Supabase RPC 기반 유사도 검색 |
| 캐시 | Redis (ioredis) | 정확 매칭 캐시 |
| 임베딩 | OpenAI text-embedding-3-small (@langchain/openai) | 1536차원, 비용 효율, LangChain Embeddings 인터페이스 활용 |
| API | F-001의 Fastify 서버에 통합 | 별도 서비스 불필요 |

---

## 7. 성공 지표

### 7.1 매칭 효율성

유사 습관 100건(동일 의미 다른 표현)을 입력하여 테스트한다.

| 지표 | 목표 |
|------|------|
| 유사도 0.7+ 매칭률 | ≥ 60% (100건 중 60건 이상이 기존 퀘스트와 매칭) |
| 유사도 0.9+ 정확 매칭률 | ≥ 30% (LLM 호출 없이 즉시 반환) |
| 오매칭률 (잘못된 습관과 매칭) | < 5% |

### 7.2 성능

| 지표 | 목표 |
|------|------|
| Redis 캐시 히트 응답 시간 | < 10ms |
| Vector DB 검색 응답 시간 | < 200ms |
| 경량 수정 (0.7~0.9) 총 시간 | < 1500ms |
| 임베딩 생성 시간 | < 100ms |

### 7.3 재활용 품질

| 지표 | 목표 |
|------|------|
| 유사도 ≥ 0.9 재활용 퀘스트의 부모 의도 보존율 | ≥ 85% |
| 0.7~0.9 경량 수정 퀘스트의 톤 일관성 | ≥ 80% |

### 7.4 PoC 통과 기준

- [ ] 유사 습관 매칭률 (0.7+) ≥ 60%
- [ ] 오매칭률 < 5%
- [ ] Vector DB 검색 응답 시간 < 200ms
- [ ] 재활용 퀘스트 품질이 F-001 기준과 동등

---

## 8. 테스트 계획

### 8.1 유사 습관 테스트 세트 (100건)

F-001의 사전 생성 퀘스트 40건의 원본 습관을 기준으로, 의미는 같지만 표현이 다른 변형 100건을 제작한다.

| 변형 유형 | 수량 | 예시 (원본 → 변형) |
|----------|------|-------------------|
| 동의어 교체 | 30건 | "아침 기상" → "아침에 일어나기" |
| 문장 구조 변경 | 20건 | "양치하기" → "이를 닦자" |
| 상세도 차이 | 20건 | "운동" → "저녁에 줄넘기 100번 하기" |
| 시간 변형 | 15건 | "8시 기상" → "7시 반에 일어나기" |
| 완전히 다른 습관 | 15건 | 매칭되면 안 되는 네거티브 케이스 |

### 8.2 자동화 테스트

- [ ] 100건 일괄 입력 → 처리 경로별 분포 기록
- [ ] 임계값별 (0.6/0.7/0.8/0.9) 매칭 결과 비교
- [ ] 응답 시간 측정 (경로별 분리)
- [ ] 네거티브 케이스(완전히 다른 습관)가 잘못 매칭되는지 확인

---

## 9. 오픈 질문

| # | 질문 | 답변 필요 주체 | 블로킹 여부 |
|---|------|-------------|-----------|
| OQ-1 | pgvector의 ivfflat 인덱스가 40건 규모에서 의미가 있는가, 아니면 brute-force가 더 빠른가? | 엔지니어링 | 비블로킹 (PoC에서 실험) |
| OQ-2 | 임베딩 모델을 한국어 특화 모델(예: KoSimCSE)로 바꾸면 매칭률이 올라가는가? | 엔지니어링 | 비블로킹 (PoC에서 비교 가능) |
| OQ-3 | 경량 수정(0.7~0.9) 시 LLM에 전달하는 컨텍스트의 최적 구조는? 기존 퀘스트 전체 vs 퀘스트명만? | 엔지니어링 | 비블로킹 (PoC에서 실험) |

---

## 10. 타임라인

F-005(세계관 바이블 + 사전 생성 퀘스트) 완료 후 시작. 사전 생성 퀘스트 40건이 시드 데이터로 필요하기 때문이다. F-001의 1주차(세계관 바이블 제작) 완료 시점부터 병렬 진행 가능하며, F-001 LLM 엔진과는 독립적으로 개발할 수 있다.

| 주차 | 작업 | 산출물 |
|------|------|--------|
| **1주차** | Supabase pgvector 활성화 + 스키마/RPC 구현 + 시드 데이터 40건 적재 | DB 스키마, RPC 함수, 시드 적재 스크립트 |
| **1주차** | 임베딩 파이프라인 + 검색 API 구현 | 검색 엔드포인트 |
| **2주차** | 3단계 처리 체인 통합 + Redis 캐시 연동 | 통합 처리 파이프라인 |
| **2주차** | 유사 습관 100건 테스트 + 임계값 실험 | 매칭 결과 보고서, 최적 임계값 도출 |
| **3주차** | 재활용 품질 평가 + PoC 통과 판정 | 품질 평가표, PoC 결과 보고서 |
