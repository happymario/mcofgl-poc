# PRD: F-004 퀘스트 생성 통합 API

> **문서 버전:** 0.1 · **작성일:** 2026.03.23 · **작성자:** Mario
> **PoC 피처:** F-004 · **검증 가설:** H-1, H-3 통합
> **의존성:** F-001 (LLM 엔진), F-002 (Vector DB), F-003 (안전 필터)
> **참조:** [blueprint/llm-engine.md](../blueprint/llm-engine.md) §7

---

## 1. 문제 정의

F-001(LLM 변환), F-002(Vector DB 재활용), F-003(안전 필터)은 각각 독립 검증이 가능하지만, 실제 서비스에서는 하나의 흐름으로 동작한다. 부모가 습관을 입력하면 캐시 → Vector DB → LLM → 필터를 거쳐 최종 퀘스트가 반환되기까지의 전체 E2E 흐름을 하나의 API로 통합하고, 파이프라인 전체의 성능·안정성·비용을 검증해야 한다.

이 통합 API는 MVP 앱 개발의 직접적인 백엔드 인터페이스가 되므로, API 계약(인터페이스)을 PoC에서 확정하는 것이 중요하다.

---

## 2. 목표

| # | 목표 | 측정 방법 |
|---|------|----------|
| G-1 | F-001~F-003의 전체 파이프라인이 E2E로 정상 동작함을 확인한다 | 습관 100건 일괄 변환 → 에러율 0%, 전체 성공 |
| G-2 | 경로별(캐시/Vector DB/LLM) 성능과 비용을 실측한다 | 경로별 응답 시간 분포 + 건당 비용 보고서 |
| G-3 | MVP 앱 개발에 사용할 API 계약을 확정한다 | API 스펙 문서 + 응답 스키마 확정 |
| G-4 | 장애 시나리오(LLM 타임아웃, DB 다운)에서 폴백이 동작함을 확인한다 | 장애 주입 테스트 3종 → 전부 폴백 성공 |

---

## 3. 비목표 (Non-Goals)

| # | 비목표 | 사유 |
|---|--------|------|
| NG-1 | 사용자 인증/인가 | PoC는 API 키 또는 무인증. MVP에서 Firebase Auth 연동 |
| NG-2 | Rate limiting / 사용자별 호출 상한 | MVP에서 구현 |
| NG-3 | 프로덕션 배포 인프라 (컨테이너, CI/CD) | PoC는 로컬 또는 단일 dev 서버 |
| NG-4 | 부모 앱 / 아이 앱 UI | API 레이어만 |
| NG-5 | 멀티 테넌시 (복수 가정 동시 처리) | PoC는 단일 사용자 시나리오 |

---

## 4. 사용자 스토리

### 부모 (간접 — MVP 앱을 통해)

- **US-001:** 부모로서, 습관을 입력하면 3초 이내에 퀘스트 미리보기를 받고 싶다.
- **US-002:** 부모로서, 결과가 마음에 들지 않으면 "다시 생성"을 누르면 다른 변형을 받고 싶다.
- **US-003:** 부모로서, 시스템이 느리거나 장애가 나도 빈 화면이 아닌 무언가를 볼 수 있어야 한다.

### 개발자 (MVP 앱 개발팀)

- **US-004:** 개발자로서, 단일 API 엔드포인트에 습관 텍스트를 보내면 완성된 퀘스트 JSON을 받고 싶다. 내부 파이프라인을 알 필요가 없어야 한다.
- **US-005:** 개발자로서, 응답에 포함된 메타데이터(처리 경로, 응답 시간, 비용)를 통해 디버깅과 모니터링이 가능해야 한다.

---

## 5. 요구사항

### 5.1 Must-Have (P0)

#### R-001. 통합 API 엔드포인트

단일 엔드포인트에서 전체 파이프라인을 처리한다.

```
POST /api/quest/generate

Request:
{
  "habit_text": "아침 8시에 일어나기",
  "worldview_id": "kingdom_of_light",
  "age_group": "7-12",
  "character_context": {             // 선택적
    "name": "빛나",
    "class": "전사",
    "level": 5
  },
  "regenerate": false                // true면 캐시 무시 + 다른 변형
}

Response (200):
{
  "quest": {
    "quest_name": "새벽의 부름에 응답하라",
    "description": "어둠의 안개가 마을을...",
    "category": "생활습관",
    "stat_mapping": { "근성": 5 },
    "reward": {
      "exp": 15,
      "coin": 10,
      "buff": "새벽의 기운 (당일 EXP +10%)"
    },
    "suggested_grade": "D",
    "mandatory_suitability": "high",
    "original_habit": "아침 8시에 일어나기",
    "worldview_id": "kingdom_of_light"
  },
  "meta": {
    "processing_path": "vector_exact",  // cache | vector_exact | vector_modify | llm_new | fallback
    "similarity_score": 0.94,           // Vector DB 매칭 시
    "safety_check": "passed",           // passed | replaced | fallback
    "latency_ms": 120,
    "model_used": null,                 // LLM 호출 시 모델명
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "estimated_cost_usd": 0.0
  }
}
```

**인수 기준:**

- [ ] 정상 요청에 대해 위 스키마대로 응답한다
- [ ] habit_text가 비어있으면 400 에러를 반환한다
- [ ] worldview_id가 존재하지 않는 세계관이면 400 에러를 반환한다
- [ ] regenerate=true 시 Redis 캐시를 건너뛰고 다른 변형을 반환한다

#### R-002. E2E 처리 파이프라인

```
요청 수신
  ↓
① Redis 정확 매칭 (regenerate=false일 때)
  → HIT: 안전 필터(캐시 결과도 검증) → 반환
  ↓
② Vector DB 유사도 검색
  → sim ≥ 0.9: 안전 필터 → 반환
  → 0.7 ≤ sim < 0.9: LLM 경량 수정 → 안전 필터 → 저장 → 반환
  → sim < 0.7: ③으로
  ↓
③ LLM 신규 생성 (F-001)
  → 안전 필터 (F-003)
    → safe: Vector DB + Redis에 저장 → 반환
    → unsafe: 폴백 (사전 생성 퀘스트) → 반환
  ↓
④ LLM 타임아웃/에러 시
  → 폴백 (사전 생성 퀘스트) → 반환
```

**인수 기준:**

- [ ] 모든 경로에서 최종 응답 전에 안전 필터를 거친다
- [ ] 신규 생성된 퀘스트는 자동으로 Vector DB + Redis에 저장된다
- [ ] 폴백 시 processing_path가 "fallback"으로 기록된다
- [ ] 어떤 경로로 처리되든 응답 스키마가 동일하다

#### R-003. 성능 목표 달성

| 처리 경로 | 목표 응답 시간 |
|----------|-------------|
| Redis 캐시 히트 | < 100ms |
| Vector DB 정확 매칭 (≥ 0.9) | < 300ms |
| Vector DB 경량 수정 (0.7~0.9) | < 2000ms |
| LLM 신규 생성 | < 3500ms |
| 폴백 | < 300ms |

**인수 기준:**

- [ ] 100건 일괄 테스트에서 각 경로의 p95 응답 시간이 위 목표를 충족한다
- [ ] 전체 평균 응답 시간을 경로별 비율과 함께 보고한다

#### R-004. 장애 대응 (Graceful Degradation)

외부 서비스(LLM API, Vector DB, Redis)가 실패해도 API가 응답을 반환한다.

**인수 기준:**

- [ ] LLM API 타임아웃(10초) 시 폴백으로 전환한다
- [ ] Vector DB 접속 불가 시 LLM 직접 생성으로 우회한다
- [ ] Redis 접속 불가 시 캐시 단계를 건너뛰고 Vector DB로 진행한다
- [ ] 모든 장애 시나리오에서 에러가 아닌 유효한 퀘스트를 반환한다

#### R-005. 비용 추적

모든 LLM 호출의 토큰 수와 추정 비용을 기록한다.

**인수 기준:**

- [ ] 응답 meta에 prompt_tokens, completion_tokens, estimated_cost_usd가 포함된다
- [ ] LLM 미호출 시(캐시/Vector DB) 0으로 기록된다
- [ ] 일괄 테스트 후 총 비용 및 건당 평균 비용 보고서를 생성한다

### 5.2 Nice-to-Have (P1)

#### R-006. 배치 API

복수 습관을 한 번에 변환한다.

```
POST /api/quest/generate/batch

Request:
{
  "habits": [
    { "habit_text": "양치하기", "worldview_id": "kingdom_of_light", "age_group": "7-12" },
    { "habit_text": "독서 30분", "worldview_id": "kingdom_of_light", "age_group": "7-12" }
  ]
}
```

**인수 기준:**

- [ ] 최대 20건까지 배치 처리한다
- [ ] 개별 건의 실패가 전체를 중단하지 않는다 (부분 성공 가능)
- [ ] 병렬 처리로 총 시간이 순차 처리 대비 50% 이하다

#### R-007. 헬스체크 엔드포인트

시스템 상태를 확인한다.

```
GET /api/health

Response:
{
  "status": "healthy",
  "components": {
    "redis": "connected",
    "vector_db": "connected",
    "llm_api": "reachable"
  }
}
```

### 5.3 Future Considerations (P2)

| 항목 | 설명 | 현재 대응 |
|------|------|----------|
| 인증/인가 | Firebase Auth 토큰 검증 | MVP에서 미들웨어 추가 |
| Rate limiting | 사용자당 일일 호출 상한 | MVP에서 Redis 기반 구현 |
| 비동기 웹소켓 | LLM 생성 중 스트리밍 피드백 | PoC에서는 동기 응답 |
| 캐시 무효화 | 세계관 바이블 업데이트 시 관련 캐시 클리어 | PoC에서는 수동 클리어 |

---

## 6. 기술 명세

### 6.1 기술 스택

| 레이어 | 선택 | 사유 |
|--------|------|------|
| API 프레임워크 | TypeScript + Fastify | 기존 프로젝트와 동일 스택, 비동기 지원, @fastify/swagger로 OpenAPI 문서 자동 생성 |
| LLM 오케스트레이션 | LangChain/LangGraph (TS) | 파이프라인 체인 조합, 프롬프트 관리, 기존 프로젝트 노하우 활용 |
| LLM 클라이언트 | @anthropic-ai/sdk + @langchain/anthropic | Anthropic 모델 기본 |
| Vector DB | Supabase (PostgreSQL + pgvector, SupabaseVectorStore) | F-002와 공유, 호스티드 DB |
| 캐시 | Redis (ioredis) | F-002와 공유 |
| 임베딩 | OpenAI text-embedding-3-small (@langchain/openai) | F-002와 공유 |
| DB 클라이언트 | @supabase/supabase-js | Supabase API 접근, MVP에서 Auth/RLS 확장 |
| 테스트 | Vitest + supertest | E2E 테스트 자동화 |

### 6.2 프로젝트 구조 (PoC)

```
poc-server/
├── src/
│   ├── index.ts                # Fastify 앱 진입점
│   ├── config.ts               # 환경 설정 (임계값, 모델, 타임아웃)
│   ├── routes/
│   │   └── quest.ts            # /api/quest/* 라우터
│   ├── services/
│   │   ├── pipeline.ts         # 통합 파이프라인 오케스트레이터 (LangGraph)
│   │   ├── llm-engine.ts       # F-001 LLM 변환 (LangChain)
│   │   ├── vector-store.ts     # F-002 Vector DB 검색/저장 (SupabaseVectorStore)
│   │   ├── cache.ts            # Redis 정확 매칭 (ioredis)
│   │   └── safety-filter.ts    # F-003 안전 필터
│   ├── schemas/
│   │   ├── quest.ts            # 퀘스트 Zod/TypeBox 스키마
│   │   └── request.ts          # 요청/응답 스키마
│   └── prompts/
│       ├── transform.ts        # 퀘스트 변환 프롬프트 템플릿
│       └── safety-check.ts     # 안전 검증 프롬프트 템플릿
├── data/
│   ├── worldviews/             # 세계관 바이블 JSON
│   ├── seed-quests/            # 사전 생성 퀘스트 JSON
│   └── safety-rules.json       # 차단 키워드/패턴
├── tests/
│   ├── pipeline.e2e.test.ts    # E2E 통합 테스트
│   ├── llm-engine.test.ts      # F-001 단위 테스트
│   ├── vector-store.test.ts    # F-002 단위 테스트
│   ├── safety-filter.test.ts   # F-003 단위 테스트
│   └── fixtures/               # 테스트 데이터
├── scripts/
│   ├── seed-db.ts              # 시드 데이터 적재
│   ├── run-eval.ts             # 품질 평가 스크립트
│   └── cost-report.ts          # 비용 분석 스크립트
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 6.3 에러 응답 스키마

```json
{
  "error": {
    "code": "INVALID_WORLDVIEW",
    "message": "세계관 ID 'xxx'을 찾을 수 없습니다.",
    "details": {}
  }
}
```

| 에러 코드 | HTTP 상태 | 설명 |
|----------|----------|------|
| INVALID_REQUEST | 400 | 필수 필드 누락 또는 잘못된 형식 |
| INVALID_WORLDVIEW | 400 | 존재하지 않는 세계관 ID |
| LLM_TIMEOUT | 200 | LLM 타임아웃 → 폴백 결과 반환 (에러 아님) |
| INTERNAL_ERROR | 500 | 예기치 않은 서버 에러 |

---

## 7. 성공 지표

### 7.1 E2E 안정성

| 지표 | 목표 |
|------|------|
| 100건 일괄 변환 성공률 | 100% (에러 0건) |
| 장애 주입 시 폴백 성공률 | 100% (3종 시나리오 전부) |

### 7.2 성능 분포

100건 테스트 후 경로별 분포와 성능을 보고한다.

| 보고 항목 | 내용 |
|----------|------|
| 경로별 처리 비율 | cache / vector_exact / vector_modify / llm_new / fallback 각 % |
| 경로별 평균 응답 시간 | ms 단위 |
| 경로별 p95 응답 시간 | ms 단위 |
| 전체 평균 응답 시간 | ms 단위 |

### 7.3 비용

| 보고 항목 | 내용 |
|----------|------|
| 총 LLM 호출 횟수 | 건수 |
| 총 토큰 사용량 | prompt + completion |
| 총 비용 | USD |
| 건당 평균 비용 (LLM 호출 건만) | USD |
| 건당 평균 비용 (전체 100건 기준) | USD |

### 7.4 PoC 통과 기준

- [ ] 100건 일괄 변환 에러 0건
- [ ] 장애 주입 3종 시나리오 폴백 100% 성공
- [ ] 경로별 p95 응답 시간이 R-003 목표 이내
- [ ] API 스키마가 확정되어 MVP 앱 개발 착수 가능

---

## 8. 테스트 계획

### 8.1 E2E 테스트 세트 (100건)

F-001의 습관 50건 + F-002의 유사 습관 테스트에서 50건을 합산하여 총 100건. 다양한 경로를 커버하도록 구성.

| 유형 | 수량 | 기대 경로 |
|------|------|----------|
| 사전 생성 퀘스트와 동일 습관 | 10건 | cache 또는 vector_exact |
| 사전 생성과 유사한 습관 | 30건 | vector_exact 또는 vector_modify |
| 새로운 유형의 습관 | 40건 | llm_new |
| 부적절 표현 포함 습관 | 10건 | llm_new → safety fallback |
| 재생성 요청 (regenerate=true) | 10건 | cache 스킵 확인 |

### 8.2 장애 주입 테스트

| 시나리오 | 방법 | 기대 결과 |
|----------|------|----------|
| LLM API 타임아웃 | LLM 호출에 인위적 10초 딜레이 | 폴백 퀘스트 반환, path="fallback" |
| Vector DB 다운 | pgvector 연결 차단 | LLM 직접 생성으로 우회 |
| Redis 다운 | Redis 연결 차단 | 캐시 스킵, Vector DB부터 시작 |

### 8.3 부하 테스트 (간이)

| 시나리오 | 목표 |
|----------|------|
| 동시 요청 5건 | 모든 요청 정상 응답 |
| 동시 요청 10건 | 응답 시간 2배 이내 유지 |

---

## 9. 오픈 질문

| # | 질문 | 답변 필요 주체 | 블로킹 여부 |
|---|------|-------------|-----------|
| OQ-1 | regenerate 시 이전 결과와 "다른" 결과를 보장하는 방법은? temperature 조정 vs 프롬프트 변형 vs Vector DB 2순위 반환? | 엔지니어링 | 비블로킹 (PoC에서 실험) |
| OQ-2 | MVP에서 이 API를 Flutter 앱이 직접 호출하는가, BFF(Backend for Frontend) 레이어를 거치는가? | 엔지니어링 | 비블로킹 (MVP 아키텍처에서 결정) |
| OQ-3 | 비용 보고서의 기준 환율과 모델별 단가는 어디서 관리하는가? | 엔지니어링 | 비블로킹 |

---

## 10. 타임라인

F-001, F-002, F-003의 기본 구현이 완료된 후 통합. 각 피처의 2주차부터 병렬로 통합 작업 시작 가능.

| 주차 | 작업 | 산출물 |
|------|------|--------|
| **1주차** | Fastify 스켈레톤 + Zod/TypeBox 스키마 + 프로젝트 구조 | 서버 기본 구조 |
| **1주차** | F-001/F-002/F-003 서비스 모듈 통합 | 파이프라인 오케스트레이터 |
| **2주차** | E2E 테스트 100건 + 장애 주입 테스트 | 테스트 결과 |
| **2주차** | 성능 측정 + 비용 분석 | 성능/비용 보고서 |
| **3주차** | API 스키마 확정 + PoC 최종 보고서 | API 문서, PoC 종합 보고서 |
