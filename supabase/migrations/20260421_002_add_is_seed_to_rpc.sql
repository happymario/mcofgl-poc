-- F-003 Task 5: match_quest_vectors RPC의 RETURNS TABLE에 is_seed 컬럼을 추가한다.
--
-- 목적:
--   FallbackSelector가 유사도 검색 결과 중 is_seed=true 항목만을 상위 폴백 후보로 쓰려면
--   RPC 응답에도 is_seed 컬럼이 포함되어야 한다. (코드에서 추가 필터링 수행.)
--
-- 참고:
--   CREATE OR REPLACE FUNCTION은 반환 타입(RETURNS TABLE 컬럼 구성)을 변경할 수 없다.
--   따라서 기존 함수를 DROP한 뒤 동일 시그니처로 재생성한다. IF EXISTS로 idempotent 보장.
--   시그니처(IN 파라미터)는 20260421_001과 동일하게 유지한다.

DROP FUNCTION IF EXISTS public.match_quest_vectors(
  vector,
  text,
  text,
  int
);

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
  similarity   float,
  is_seed      boolean
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
    1 - (qv.embedding <=> query_embedding) AS similarity,
    qv.is_seed
  FROM public.quest_vectors qv
  WHERE
    (filter_worldview_id IS NULL OR qv.worldview_id = filter_worldview_id)
    AND (filter_age_group IS NULL OR qv.age_group = filter_age_group)
  ORDER BY qv.embedding <=> query_embedding
  LIMIT match_count;
$$;
