# Supabase Migrations

이 디렉토리는 F-002 Vector DB 퀘스트 재활용 시스템의 데이터베이스 마이그레이션 파일을 포함합니다.

## 마이그레이션 목록

| 파일 | 설명 |
|------|------|
| `20260421_001_quest_vectors.sql` | `quest_vectors` 테이블, ivfflat 인덱스, `match_quest_vectors` RPC 생성 |

## 적용 방법

### 방법 1: Supabase SQL Editor (권장)

1. [Supabase 대시보드](https://supabase.com/dashboard) → 프로젝트 선택
2. 좌측 메뉴 **SQL Editor** 클릭
3. `20260421_001_quest_vectors.sql` 파일 내용을 붙여넣기
4. **Run** 클릭

### 방법 2: psql 직접 실행

```bash
# Supabase 프로젝트의 DB 연결 문자열 (대시보드 > Settings > Database > Connection string)
export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"

psql "$SUPABASE_DB_URL" -f supabase/migrations/20260421_001_quest_vectors.sql
```

## 보안 정책

`quest_vectors` 테이블은 **RLS(Row Level Security)가 활성화**되어 있습니다. PoC 단계에서는 `SUPABASE_SERVICE_ROLE_KEY`를 사용하는 서버 코드만 접근합니다. `anon` 또는 `authenticated` 역할에서 접근해야 할 경우 MVP에서 별도 RLS 정책을 추가하세요.

## 시드 데이터 적재 순서

ivfflat 인덱스의 centroid는 `CREATE INDEX` 시점의 테이블 데이터를 기준으로 학습됩니다. 마이그레이션 직후에는 테이블이 비어 있으므로, **시드 데이터 적재 후 반드시 REINDEX를 실행**해야 합니다.

```bash
# 1. 마이그레이션 적용
# 2. 시드 데이터 적재
npm run seed:vectors

# 3. Supabase SQL Editor에서 인덱스 재학습
```

```sql
-- 시드 적재 완료 후 실행
REINDEX INDEX idx_quest_vectors_embedding;
```

## 적용 확인

마이그레이션 적용 후 아래 쿼리로 검증:

```sql
-- 테이블 존재 확인
SELECT table_name FROM information_schema.tables
WHERE table_name = 'quest_vectors';

-- RPC 존재 확인 (1행 반환되어야 함)
SELECT * FROM pg_proc WHERE proname = 'match_quest_vectors';

-- 인덱스 확인
SELECT indexname FROM pg_indexes WHERE tablename = 'quest_vectors';
```

## 롤백

마이그레이션을 되돌리려면 아래 SQL을 실행:

```sql
-- RPC 제거
DROP FUNCTION IF EXISTS public.match_quest_vectors(vector(1536), text, text, int);

-- 테이블 및 인덱스 제거 (데이터 포함)
DROP TABLE IF EXISTS public.quest_vectors;

-- pgvector 확장 제거 (다른 벡터 컬럼이 없는 경우에만)
-- DROP EXTENSION IF EXISTS vector;
```

> **주의**: `DROP TABLE`은 모든 시드 및 사용자 데이터를 삭제합니다.

## 재실행 (시드 데이터 초기화)

시드 데이터를 다시 적재해야 할 경우:

```sql
-- 기존 데이터 초기화 후 재적재
TRUNCATE TABLE quest_vectors;
```

그 후 `npm run seed:vectors`를 다시 실행하세요.
