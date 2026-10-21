-- Apply after runtime-grants.sql as migration administrator. A separate worker
-- LOGIN inherits this group; API logins must not inherit the dispatch capability.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='resolvehub_worker') THEN
  CREATE ROLE resolvehub_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO resolvehub_worker',current_schema());
END $$;
GRANT SELECT ON organizations,memberships,embedding_configuration,schema_migrations TO resolvehub_worker;
GRANT SELECT,UPDATE ON knowledge_documents,document_versions,job_runs TO resolvehub_worker;
GRANT SELECT,INSERT,UPDATE ON knowledge_chunks,job_attempts TO resolvehub_worker;
GRANT SELECT,INSERT ON ingestion_artifacts,failed_jobs,audit_events TO resolvehub_worker;
GRANT EXECUTE ON FUNCTION ingestion_dispatch_candidates() TO resolvehub_worker;

GRANT SELECT ON tickets,ticket_messages TO resolvehub_worker;
GRANT SELECT,INSERT ON draft_responses TO resolvehub_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON citations TO resolvehub_worker;
GRANT EXECUTE ON FUNCTION drafting_dispatch_candidates() TO resolvehub_worker;
GRANT EXECUTE ON FUNCTION drafting_lock_authority(uuid,uuid) TO resolvehub_worker;

GRANT EXECUTE ON FUNCTION operational_queue_snapshot() TO resolvehub_worker;
