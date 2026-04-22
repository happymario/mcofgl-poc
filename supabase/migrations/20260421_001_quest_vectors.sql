-- F-002 Vector DB: quest_vectors 테이블 및 match_quest_vectors RPC
-- 적용: Supabase SQL Editor에 붙여넣기 또는 psql "$SUPABASE_DB_URL" -f <file>

-- pgvector 확장 활성화
-- Supabase 대시보드로 설치 시 extensions 스키마, SQL로 직접 설치 시 public 스키마.
-- 어느 쪽이든 search_path에 두 스키마를 포함해 연산자/타입이 올바르게 해석되도록 함.
CREATE EXTENSION IF NOT EXISTS vector;

-- quest_vectors 테이블
-- worldview_id, age_group은 스펙 §3.3 원안이 VARCHAR이나 PoC에서는 TEXT를 사용.
-- Postgres에서 동작 차이 없으며 길이 제약보다 유연성을 우선함.
CREATE TABLE IF NOT EXISTS public.quest_vectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worldview_id  TEXT NOT NULL,
  -- age_group 기본값 없음: VectorStore가 항상 명시적으로 전달해야 함
  age_group     TEXT NOT NULL,
  input_text    TEXT NOT NULL,
  -- text-embedding-3-small 차원 (1536)
  embedding     vector(1536),
  quest_result  JSONB NOT NULL,
  is_seed       BOOLEAN NOT NULL DEFAULT false,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  quality_score FLOAT NOT NULL DEFAULT 0.0,  -- P2 예약 필드
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS 활성화 (default-deny)
-- PoC: service_role 키로만 접근. anon/authenticated 정책은 MVP에서 추가.
ALTER TABLE public.quest_vectors ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.quest_vectors IS
  '서버 전용 테이블. service_role 키로만 접근. '
  'anon/authenticated 역할에 노출 전 반드시 RLS 정책 추가 필요.';

-- ivfflat 인덱스는 PoC(~100건) 규모에서 생성에 ~60MB maintenance_work_mem이 필요하며
-- Supabase 기본값(32MB)을 초과한다. 100건 이하에서는 sequential scan이 더 빠르므로 제외.
-- 수천 건 이상으로 데이터가 늘어나면 아래 SQL로 별도 생성:
--   SET maintenance_work_mem = '128MB';
--   CREATE INDEX idx_quest_vectors_embedding
--     ON public.quest_vectors USING ivfflat (embedding vector_cosine_ops)
--     WITH (lists = 100);

-- 사전 필터 인덱스 (worldview_id + age_group 조합)
-- match_quest_vectors RPC의 WHERE 조건에 대응
CREATE INDEX IF NOT EXISTS idx_quest_vectors_filter
  ON public.quest_vectors (worldview_id, age_group);

-- match_quest_vectors RPC
-- 입력 임베딩과 코사인 유사도 기준 상위 N개 반환.
-- filter_worldview_id / filter_age_group이 NULL이면 해당 조건 무시.
--
-- search_path에 extensions를 포함: Supabase 대시보드 설치 시 pgvector가
-- extensions 스키마에 위치하므로 <=> 연산자를 스키마 한정 없이 사용할 수 있음.
CREATE OR REPLACE FUNCTION public.match_quest_vectors(
  query_embedding     vector(1536),
  filter_worldview_id text    DEFAULT NULL,
  filter_age_group    text    DEFAULT NULL,
  match_count         int     DEFAULT 5
)
RETURNS TABLE (
  id           uuid,
  input_text   text,
  quest_result jsonb,
  similarity   float
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    qv.id,
    qv.input_text,
    qv.quest_result,
    1 - (qv.embedding <=> query_embedding) AS similarity
  FROM public.quest_vectors qv
  WHERE
    (filter_worldview_id IS NULL OR qv.worldview_id = filter_worldview_id)
    AND (filter_age_group IS NULL OR qv.age_group = filter_age_group)
  ORDER BY qv.embedding <=> query_embedding
  LIMIT match_count;
$$;
