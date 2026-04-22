# src/scripts — 운영 CLI 스크립트

F-002 Task 8에서 추가된 시드 벡터 적재 CLI의 사용 설명서.

## seed-vectors.ts — 시드 벡터 적재

F-001 평가 러너가 생성한 `data/evaluations/run-*.json`을 읽어
각 item의 `habitText` + `quest`를 Vector DB(`quest_vectors`)에 `is_seed=true`로 적재한다.

### 사전 조건

1. **Task 2 마이그레이션 적용 완료**
   - `supabase/migrations/20260421_001_quest_vectors.sql` 가 운영 DB에 적용되어 있어야 한다.
   - `quest_vectors` 테이블과 `match_quest_vectors` RPC, `idx_quest_vectors_embedding` 인덱스가 존재해야 한다.

2. **`.env` 에 다음 키가 설정되어 있어야 한다** (dry-run이 아닐 때)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `OPENAI_API_KEY`
   - `OPENAI_EMBEDDING_MODEL` (예: `text-embedding-3-small`)

3. **적재 대상 평가 JSON이 존재**
   - 기본 입력: `data/evaluations/run-2026-04-21T09-06-13-277Z.json`
   - 다른 파일을 쓰려면 `--input=<path>` 로 지정한다.

### 실행 절차

기본 실행 (기본 입력 파일 사용):

```bash
npm run seed:vectors
```

입력 파일 지정:

```bash
npm run seed:vectors -- --input=data/evaluations/run-2026-04-21T09-06-13-277Z.json
```

### Dry-run (네트워크 호출 없음)

환경변수 없이도 동작한다. 시드 대상 건수만 출력하고 종료한다.

```bash
npm run seed:vectors -- --dry-run
```

출력 예시:

```
[seed] 입력: data/evaluations/run-2026-04-21T09-06-13-277Z.json (전체 100건, 시드 대상 100건)
[seed] dry-run: 시드 대상 100건
```

`quest`가 `null`인 item(변환 실패 샘플)은 시드 대상에서 제외된다.

### 재실행 시 TRUNCATE 절차

동일 평가 JSON을 여러 번 적재하면 `quest_vectors` 테이블에 중복 행이 쌓인다.
재실행 전에 다음 SQL로 기존 시드 행을 제거한다.

전체 테이블을 비울 때:

```sql
TRUNCATE TABLE quest_vectors;
```

시드 행만 비우고 운영 적재분은 보존할 때:

```sql
DELETE FROM quest_vectors WHERE is_seed = true;
```

### 시드 적재 후 REINDEX

대량 INSERT 이후 IVFFlat 인덱스의 클러스터링이 최신 분포와 어긋날 수 있다.
적재 직후 한 번 REINDEX를 수행해 조회 품질을 복구한다.

```sql
REINDEX INDEX idx_quest_vectors_embedding;
```

### 동작 요약

- 개별 item 실패는 로그에만 기록되고 전체 실행은 중단되지 않는다.
- 완료 시 요약이 출력된다: `시드 적재 완료: 성공 N건, 실패 M건`
- 진행 로그: `[seed] N/M habitId=h001 wv=kingdom_of_light ✓`
