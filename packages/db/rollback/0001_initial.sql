-- INITIAL INSTALL ONLY. Destructive: run only against a verified disposable DB
-- whose schema_migrations contains at most 0001_contract_api.sql.
-- For deployed data or later migrations, restore a verified backup instead.
BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM schema_migrations WHERE name<>'0001_contract_api.sql') THEN
  RAISE EXCEPTION 'Initial rollback refused: later migrations exist';
 END IF;
END $$;
DROP TABLE audit_events,idempotency_records,job_runs,draft_responses,knowledge_chunks,
 document_versions,knowledge_documents,ticket_messages,tickets,webhook_integrations,
 api_credentials,memberships,organizations CASCADE;
DELETE FROM schema_migrations WHERE name='0001_contract_api.sql';
COMMIT;
