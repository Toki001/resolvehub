-- Expand-only: legacy rows/jobs keep empty metadata; no domain envelope changes.
ALTER TABLE job_runs ADD COLUMN trace_context jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE job_runs ADD CONSTRAINT job_trace_context_safe CHECK (
  jsonb_typeof(trace_context)='object' AND trace_context-'traceparent'='{}'::jsonb
  AND (NOT trace_context ? 'traceparent' OR jsonb_typeof(trace_context->'traceparent')='string' AND length(trace_context->>'traceparent')=55 AND trace_context->>'traceparent' ~ '^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$')
);
-- A worker may see only aggregate operational state across organizations.
-- No identifiers, customer fields, SQL parameters or raw payloads are returned.
DO $migration$ BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION operational_queue_snapshot() RETURNS TABLE(
   job_kind text,pending bigint,active bigint,oldest_age_seconds float8,dead_letters bigint,retries bigint
 ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,%I,pg_temp AS $fn$
 SELECT k.kind,
  (SELECT count(*) FROM job_runs j WHERE j.kind=k.kind AND j.status='accepted'),
  (SELECT count(*) FROM job_runs j WHERE j.kind=k.kind AND j.status='processing'),
  coalesce((SELECT greatest(0,extract(epoch FROM now()-min(j.created_at)))::float8 FROM job_runs j WHERE j.kind=k.kind AND j.status IN('accepted','processing')),0),
  (SELECT count(*) FROM failed_jobs f JOIN job_runs j ON j.organization_id=f.organization_id AND j.id=f.job_id WHERE j.kind=k.kind AND f.replayed_as IS NULL),
  coalesce((SELECT sum(greatest(j.attempts-1,0))::bigint FROM job_runs j WHERE j.kind=k.kind),0)
 FROM (VALUES('document_ingestion'::text),('draft_response'::text)) k(kind)
 $fn$ $ddl$,current_schema());
END $migration$;
REVOKE ALL ON FUNCTION operational_queue_snapshot() FROM PUBLIC;
