-- Expand-only: old drafts remain readable, generation metadata is explicitly null.
ALTER TABLE draft_responses ADD COLUMN generation jsonb;
ALTER TABLE draft_responses ADD COLUMN source_job_id uuid;
ALTER TABLE draft_responses ADD CONSTRAINT draft_source_job_unique UNIQUE (organization_id,source_job_id);
ALTER TABLE draft_responses ADD CONSTRAINT draft_source_job_owned FOREIGN KEY (organization_id,source_job_id) REFERENCES job_runs(organization_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX drafting_dispatch ON job_runs(available_at,dispatch_after,created_at,id)
 WHERE kind='draft_response' AND status IN ('accepted','processing');
DO $migration$ BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION drafting_dispatch_candidates() RETURNS TABLE(job_id uuid,organization_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,%I,pg_temp AS $fn$
 SELECT j.id,j.organization_id FROM job_runs j WHERE j.kind='draft_response'
 AND j.status IN ('accepted','processing') AND j.available_at<=now() AND j.dispatch_after<=now()
 ORDER BY j.available_at,j.created_at,j.id LIMIT 100
 $fn$ $ddl$,current_schema());
END $migration$;
REVOKE ALL ON FUNCTION drafting_dispatch_candidates() FROM PUBLIC;
