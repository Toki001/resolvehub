-- Durable handoff, authoritative attempt budget, checkpoints and application DLQ.
ALTER TABLE job_runs ADD COLUMN requested_by uuid;
ALTER TABLE job_runs ADD CONSTRAINT job_requester_owned FOREIGN KEY (organization_id,requested_by)
 REFERENCES memberships(organization_id,id) DEFERRABLE INITIALLY DEFERRED;
UPDATE job_runs j SET requested_by=a.actor_id FROM audit_events a
 WHERE a.organization_id=j.organization_id AND a.resource_id=j.id AND a.action='ingestion.accepted' AND a.actor_kind='membership';
ALTER TABLE job_runs ADD COLUMN available_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE job_runs ADD COLUMN dispatch_after timestamptz(3) NOT NULL DEFAULT now();
CREATE INDEX ingestion_dispatch ON job_runs (available_at,dispatch_after,created_at,id)
 WHERE kind='document_ingestion' AND status IN ('accepted','processing');
CREATE UNIQUE INDEX one_live_ingestion_version ON job_runs (organization_id,(payload->>'versionId'))
 WHERE kind='document_ingestion' AND status IN ('accepted','processing');

CREATE TABLE job_attempts (
 organization_id uuid NOT NULL,
 job_id uuid NOT NULL,
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 4),
 stage text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('running','succeeded','transient','permanent','abandoned')),
 error_category text,
 summary text,
 started_at timestamptz(3) NOT NULL DEFAULT now(),
 finished_at timestamptz(3),
 PRIMARY KEY (organization_id,job_id,attempt),
 FOREIGN KEY (organization_id,job_id) REFERENCES job_runs(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE ingestion_artifacts (
 organization_id uuid NOT NULL,
 document_id uuid NOT NULL,
 version_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 extracted_text text NOT NULL CHECK (length(extracted_text) BETWEEN 1 AND 200000),
 pipeline_version text NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,document_id,version_id),
 FOREIGN KEY (organization_id,document_id,version_id) REFERENCES document_versions(organization_id,document_id,id) ON DELETE CASCADE
);
CREATE TABLE failed_jobs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 job_id uuid NOT NULL,
 error_category text NOT NULL,
 summary text NOT NULL,
 input_fingerprint text NOT NULL,
 request_id uuid NOT NULL,
 replay_eligible boolean NOT NULL,
 replayed_as uuid,
 failed_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE (organization_id,job_id),
 FOREIGN KEY (organization_id,job_id) REFERENCES job_runs(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY (organization_id,replayed_as) REFERENCES job_runs(organization_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX failed_jobs_page ON failed_jobs (organization_id,failed_at DESC,id DESC);
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_attempts_tenant ON job_attempts USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE ingestion_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingestion_artifacts_tenant ON ingestion_artifacts USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE failed_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY failed_jobs_tenant ON failed_jobs USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);

-- Narrow cross-tenant dispatch and aggregate admission capabilities. Capture the
-- trusted migration schema explicitly, excluding caller/temp schema resolution.
DO $migration$ BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION ingestion_pending_count() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,%I,pg_temp AS $fn$
 SELECT count(*)::integer FROM job_runs WHERE kind='document_ingestion' AND status IN ('accepted','processing')
 $fn$ $ddl$,current_schema());
 EXECUTE format($ddl$
 CREATE FUNCTION ingestion_dispatch_candidates() RETURNS TABLE(job_id uuid,organization_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,%I,pg_temp AS $fn$
 SELECT j.id,j.organization_id FROM job_runs j WHERE j.kind='document_ingestion'
  AND j.status IN ('accepted','processing') AND j.available_at<=now() AND j.dispatch_after<=now()
 ORDER BY j.available_at,j.created_at,j.id LIMIT 100
 $fn$ $ddl$,current_schema());
END $migration$;
REVOKE ALL ON FUNCTION ingestion_pending_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION ingestion_dispatch_candidates() FROM PUBLIC;
