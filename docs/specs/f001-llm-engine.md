---
last_modified: 2026-04-21
author: @mario
status: Active
---

# F-001 LLM 세계관 변환 엔진

> 부모가 입력한 한국어 습관 텍스트를 세계관 바이블 교체만으로 다른 톤의 RPG 퀘스트 JSON으로 변환하는 LLM 엔진 PoC.

## 개요

`POST /api/quest/transform` 엔드포인트를 통해 습관 텍스트를 받아 Claude Haiku로 RPG 퀘스트를 생성한다. 변환 품질과 세계관 전환 가능성이라는 두 가지 핵심 가설을 검증하는 것이 이 PoC의 목적이다.

**기술 스택**: TypeScript + Fastify 5 + @anthropic-ai/sdk + Zod + Vitest. LangChain은 사용하지 않는다.

**검증 대상 가설**:
- H-1: LLM이 습관 텍스트를 세계관에 몰입감 있는 RPG 퀘스트로 변환할 수 있는가
- H-2: 세계관 바이블 JSON 교체만으로 동일 파이프라인이 다른 톤을 생성할 수 있는가

## 구조 / 스키마

### 디렉토리 구조

```
src/
├── index.ts                         진입점
├── api/
│   ├── server.ts                    Fastify 서버 및 라우트 정의
│   └── index.ts                     서버 시작
├── core/
│   ├── transformer.ts               QuestTransformer (Anthropic SDK 호출)
│   ├── errors.ts                    ParseError / ValidationError
│   ├── schemas/
│   │   ├── api.ts                   TransformRequestSchema / TransformResponseSchema
│   │   ├── quest.ts                 QuestSchema (Zod)
│   │   └── worldview.ts             WorldviewBibleSchema (Zod)
│   └── prompt/
│       ├── assemble.ts              시스템 프롬프트 조립기 (순수 함수)
│       ├── common-rules.ts          공통 규칙 블록
│       └── load-bible.ts            바이블 JSON 파일 로더
└── eval/
    ├── runner.ts                    100건 변환 CLI (eval:run)
    ├── blind-generator.ts           블라인드 CSV 생성 CLI (eval:blind)
    ├── metrics.ts                   MetricsCollector (p50/p95 선형 보간)
    ├── forbidden-matcher.ts         금지 표현 키워드 매칭
    └── cross-worldview-checker.ts   세계관 교차 오염 검사

data/
├── worldviews/
│   ├── kingdom_of_light.json        중세 판타지 세계관 바이블
│   └── starlight_magic_school.json  마법 학원 세계관 바이블
├── habits/
│   └── sample-50.json              평가용 습관 샘플 50건
└── evaluations/                    평가 실행 결과 저장소

tests/                              Vitest 테스트 (142개, 커버리지 91%)
```

### 세계관 바이블 스키마

세계관마다 `data/worldviews/<id>.json` 하나. 파일 교체만으로 톤이 전환된다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` | `string` | 세계관 식별자 (예: `kingdom_of_light`) |
| `background` | `string` | 세계관 배경 설명 (200-300자) |
| `tone.keywords` | `string[]` | 톤 키워드 (예: 영웅적, 장엄, 사명감) |
| `tone.forbidden` | `string[]` | 금지 표현 목록 |
| `tone.examples` | `string[]` | 톤 예시 문장 |
| `vocabulary` | `Record<string, string>` | 어휘 치환 사전 (공백 키 불허) |
| `npcs` | `WorldviewNpc[]` | NPC 목록 (name, role, personality, speech_style) |
| `few_shots` | `WorldviewFewShot[]` | 퀘스트 생성 few-shot 예시 |

현재 구현된 세계관:
- `kingdom_of_light`: 중세 판타지 (영웅적, 장엄, 사명감). 어휘 39개, NPC 4명, few-shot 5개
- `starlight_magic_school`: 마법 학원물 (따뜻, 호기심, 성장). 어휘 48개, NPC 3명, few-shot 5개

### 퀘스트 출력 스키마 (QuestSchema)

```typescript
{
  quest_name:             string
  description:            string
  category:               "기상/취침" | "위생" | "식사" | "학습" |
                          "운동/외출" | "정리정돈" | "사회성" | "생활습관"
  stat_mapping:           Record<"체력" | "지혜" | "매력" | "근성", number>
  reward: {
    exp:  number
    coin: number
    buff: string          // optional
  }
  suggested_grade:        "D" | "C" | "B" | "A" | "S"
  mandatory_suitability:  "high" | "medium" | "low"
  original_habit:         string   // 요청값 강제 주입 (LLM 할루시네이션 차단)
  worldview_id:           string   // 요청값 강제 주입
}
```

`category`, `stat_mapping` 키, `suggested_grade`는 Zod enum으로 고정되어 LLM 출력 드리프트를 차단한다.

## 동작

### API

```
POST /api/quest/transform
Content-Type: application/json
```

**요청 필드**:

| 필드 | 타입 | 필수 | 제약 |
|------|------|------|------|
| `habit_text` | `string` | 필수 | 1-500자 |
| `worldview_id` | `string` | 필수 | `/^[a-z0-9_-]+$/` |
| `age_group` | `string` | 선택 | 기본값 `"7-12"` |
| `character_context` | `{ name, class, level }` | 선택 | 캐릭터 컨텍스트 주입용 |
| `regenerate` | `boolean` | 선택 | 기본값 `false` |

**응답 (200)**:

```json
{
  "quest": { /* QuestSchema */ },
  "meta": {
    "model": "claude-haiku-4-5-20251001",
    "latency_ms": 1850,
    "prompt_tokens": 1800,
    "completion_tokens": 250
  }
}
```

**에러 응답**:

| 상태 코드 | 조건 |
|-----------|------|
| `400` | Zod 입력 검증 실패 (habit_text 길이, worldview_id 형식 위반 등) |
| `422` | LLM 응답 파싱 실패 또는 Quest 스키마 검증 실패 |
| `500` | 그 외 내부 오류 (원인 미노출, 서버 측 로그만 기록) |

### 변환 파이프라인

1. Zod로 요청 body 검증 → 실패 시 즉시 400 반환
2. `loadBible(worldview_id)`로 바이블 JSON 로드
3. `assembleSystemPrompt()`로 시스템 프롬프트 조립:
   - 공통 규칙(COMMON_RULES)
   - 세계관 바이블 블록 (background / tone / vocabulary / few-shot)
   - 캐릭터 컨텍스트 블록 (선택적)
   - 연령 그룹 블록
4. Anthropic `messages.create()` 호출 (temperature 기본 0.7)
   - `regenerate=true`: temperature `+0.3` (최대 1.0 clamp) + 시스템 프롬프트에 nonce 주입
5. 응답 텍스트에서 마크다운 코드펜스 제거 후 JSON 파싱
6. `QuestSchema.safeParse()` 검증; `original_habit`·`worldview_id`는 요청값으로 강제 주입
7. 파싱 또는 검증 실패 시 temperature를 절반으로 낮춰 1회 재시도 (총 최대 2회 시도)
8. 성공 시 퀘스트 + 메타 반환

`assembleSystemPrompt`는 순수 함수다. 파일 I/O, 네트워크, 난수 등 외부 의존 없이 동일 입력에 동일 출력을 보장한다.

### 평가 파이프라인

**eval:run** (`src/eval/runner.ts`):

습관 샘플 50개 × 세계관 2개 = 최대 100건을 실제 Claude Haiku로 변환하고 결과를 JSON으로 저장한다.

```
CLI 인자:
  --model=haiku|sonnet        기본 haiku
  --worldview=<id|all>        기본 all
  --output=<path>             기본 data/evaluations/run-<timestamp>.json
  --limit=<n>                 기본 0 (전체), 1 이상이면 세계관당 상한
```

각 변환마다 자동으로 수행하는 검사:
- **ForbiddenMatcher**: `quest_name + description` 텍스트에 자기 세계관의 금지 표현 포함 여부
- **CrossWorldviewChecker**: 상대 세계관의 금지 표현이 혼입되었는지 교차 검사

출력 JSON 구조:

```json
{
  "runId": "run-<timestamp>",
  "model": "claude-haiku-4-5-20251001",
  "worldviews": ["kingdom_of_light", "starlight_magic_school"],
  "startedAt": "<ISO 8601>",
  "completedAt": "<ISO 8601>",
  "items": [
    {
      "habitId": "h001",
      "habitText": "아침 8시에 일어나기",
      "worldviewId": "kingdom_of_light",
      "quest": { /* QuestSchema */ },
      "meta": { /* 지연/토큰 */ },
      "checks": {
        "forbiddenHit": false,
        "forbiddenMatches": [],
        "crossContamination": []
      }
    }
  ],
  "summary": {
    "total": 100,
    "succeeded": 98,
    "failed": 2,
    "avgLatencyMs": 1850,
    "p95LatencyMs": 3200,
    "totalPromptTokens": 180000,
    "totalCompletionTokens": 25000
  }
}
```

개별 변환 실패는 전체 실행을 중단하지 않고 해당 item에 `error` 필드를 기록한 뒤 계속 진행한다.

**eval:blind** (`src/eval/blind-generator.ts`):

eval:run 결과에서 두 세계관 모두 성공한 habitId의 교집합을 추출해 세계관 라벨 없는 CSV와 정답 JSON을 생성한다. 사람 평가자가 퀘스트만 보고 세계관을 맞히는 블라인드 테스트용이다.

```
CLI 인자:
  --run=<path>           (필수) eval:run 결과 JSON
  --output=<path>        기본값: <run-dir>/<runId>-blind.csv
  --answers=<path>       기본값: <run-dir>/<runId>-answers.json
  --max-habits=<n>       기본 20
```

선택 전략: 두 세계관 모두 성공한 habitId를 오름차순 정렬 후 maxHabits 수만큼 선택. 선택된 항목을 Fisher-Yates로 섞어 itemId(b001, b002, ...) 부여. CSV는 RFC 4180 규칙을 따른다.

**MetricsCollector** (`src/eval/metrics.ts`):

각 LLM 호출의 지연/토큰/비용을 누적 기록하고 `summary()`로 집계 통계를 반환한다. p50/p95는 선형 보간 방식으로 계산한다.

## 제약사항

### 보안 제약

- `worldview_id`는 `/^[a-z0-9_-]+$/` 패턴만 허용한다 (경로 탐색 및 공백 주입 방지).
- `habit_text`는 최대 500자로 제한한다 (LLM 비용 및 DoS 방어).
- CLI `--output`, `--answers`, `--run` 인자에 `..` 세그먼트가 있으면 즉시 거부한다.
- 500 에러의 내부 원인은 클라이언트에 노출하지 않는다.

### 기능 제약

- 세계관은 현재 `kingdom_of_light`와 `starlight_magic_school` 두 가지만 지원한다.
- 바이블은 로컬 JSON 파일만 지원한다. DB나 원격 스토리지는 사용하지 않는다.
- 재시도는 최대 1회(총 2회 시도)이며, 모두 실패하면 422를 반환한다.
- 배치 변환 API는 구현하지 않았다. 단일 변환 엔드포인트만 제공한다.

### PoC 통과 기준

| 목표 | 측정 방법 | 통과 기준 |
|------|----------|-----------|
| G-1: 변환 품질 | 습관 50개 × 2세계관 4축 루브릭 평가 | 톤 ≥80%, 의도 ≥90%, 연령 ≥95%, JSON 파싱 ≥98% |
| G-2: 세계관 전환 | 동일 습관 20개 × 2세계관 블라인드 구분 | 세계관 구분 정확도 ≥90% |
| G-3: 응답 속도 | 100건 변환 측정 | 평균 < 3초, p95 < 5초 |
| G-4: 확장성 | 바이블 JSON 교체 | 코드 변경 0건으로 세계관 전환 |

### Non-goals (PoC 범위 밖)

- 아이/부모 앱 UI
- 사용자 인증 및 계정 체계
- NPC 대사, 모험 일지, 길드 마스터 편지 변환
- 스토리 퀘스트 / 분기 서사
- Vector DB 기반 재활용 체인 (F-002 별도 검증)
- 4~6세 전용 연령 분기 (파라미터 슬롯만 확보)
- 프로덕션 안전 필터 (F-003 별도 검증)
- 배치 변환 모드
- DB(Supabase) 및 Redis — MVP로 이연. PoC는 로컬 JSON + 인메모리로 충분
