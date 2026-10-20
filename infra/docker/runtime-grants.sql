-- Run once as the migration/admin role after migrations, in the target schema.
-- This NOLOGIN group owns no tables. Provision a separate LOGIN with a secret
-- through your secret manager; GRANT resolvehub_runtime TO that login.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='resolvehub_runtime') THEN
  CREATE ROLE resolvehub_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO resolvehub_runtime',current_schema());
END $$;
GRANT SELECT ON organizations,memberships,api_credentials,webhook_integrations,
 embedding_configuration,schema_migrations TO resolvehub_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON customers,tickets,ticket_messages,
 knowledge_documents,document_versions,knowledge_chunks,draft_responses,citations,
 job_runs,idempotency_records TO resolvehub_runtime;
GRANT SELECT,INSERT ON audit_events TO resolvehub_runtime;
-- Runtime cannot create roles, migrate, mutate memberships/credentials or alter
-- audit history. RLS expects SET LOCAL resolvehub.organization_id inside a tx.
