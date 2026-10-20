-- Expand existing contract storage. No existing columns/tables are removed.
-- This synthetic embedding model is explicitly defined by seeds/fixtures.ts.
-- A different model/dimension requires a new migration and reindexing.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE embedding_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 64),
  UNIQUE (model, dimensions)
);
INSERT INTO embedding_configuration VALUES (true, 'resolvehub-synthetic-sha256-v1', 64);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at timestamptz(3),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX customers_email_live ON customers (organization_id, lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX customers_page ON customers (organization_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
ALTER TABLE tickets ADD COLUMN customer_id uuid;
-- Migrate existing ticket contacts without altering the compatibility email field.
INSERT INTO customers (organization_id,email)
 SELECT organization_id,lower(customer_email) FROM tickets GROUP BY organization_id,lower(customer_email);
UPDATE tickets t SET customer_id=c.id FROM customers c
 WHERE c.organization_id=t.organization_id AND c.email=lower(t.customer_email);
ALTER TABLE tickets ADD CONSTRAINT tickets_customer_owned FOREIGN KEY (organization_id,customer_id)
 REFERENCES customers(organization_id,id);
CREATE INDEX tickets_customer ON tickets (organization_id,customer_id,created_at DESC,id DESC);
CREATE INDEX tickets_state_page ON tickets (organization_id,status,created_at DESC,id DESC);

ALTER TABLE document_versions ADD COLUMN status text NOT NULL DEFAULT 'queued'
 CHECK (status IN ('uploaded','queued','processing','indexed','failed','superseded'));
ALTER TABLE document_versions ADD COLUMN revision integer;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY organization_id,document_id ORDER BY id)::integer AS n FROM document_versions)
 UPDATE document_versions v SET revision=n.n FROM numbered n WHERE n.id=v.id;
ALTER TABLE document_versions ALTER COLUMN revision SET NOT NULL;
ALTER TABLE document_versions ADD CONSTRAINT document_revision_positive CHECK (revision>0);
ALTER TABLE document_versions ADD CONSTRAINT document_revision_unique UNIQUE (organization_id,document_id,revision);
UPDATE document_versions v SET status=CASE WHEN d.active_version_id=v.id THEN 'indexed' ELSE 'superseded' END
 FROM knowledge_documents d WHERE d.organization_id=v.organization_id AND d.id=v.document_id;
ALTER TABLE document_versions ADD COLUMN indexed_at timestamptz(3);
UPDATE document_versions SET indexed_at=now() WHERE status='indexed';
ALTER TABLE knowledge_documents DROP CONSTRAINT knowledge_documents_status_check;
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_status_check
 CHECK (status IN ('uploaded','queued','processing','indexed','failed','superseded'));

ALTER TABLE knowledge_chunks ADD COLUMN ordinal integer;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY organization_id,version_id ORDER BY created_at,id)::integer-1 AS n FROM knowledge_chunks)
 UPDATE knowledge_chunks c SET ordinal=n.n FROM numbered n WHERE n.id=c.id;
ALTER TABLE knowledge_chunks ALTER COLUMN ordinal SET NOT NULL;
ALTER TABLE knowledge_chunks ADD CONSTRAINT chunk_ordinal_positive CHECK (ordinal>=0);
ALTER TABLE knowledge_chunks ADD CONSTRAINT chunk_position_unique UNIQUE (organization_id,version_id,ordinal);
ALTER TABLE knowledge_chunks ADD CONSTRAINT chunk_evidence_identity UNIQUE (organization_id,document_id,version_id,id);
ALTER TABLE knowledge_chunks ADD COLUMN content_hash text;
UPDATE knowledge_chunks SET content_hash=encode(sha256(convert_to(text,'UTF8')),'hex');
ALTER TABLE knowledge_chunks ALTER COLUMN content_hash SET NOT NULL;
ALTER TABLE knowledge_chunks ADD CONSTRAINT chunk_hash_valid CHECK (content_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE knowledge_chunks ADD COLUMN embedding public.vector(64);
ALTER TABLE knowledge_chunks ADD COLUMN embedding_model text;
ALTER TABLE knowledge_chunks ADD COLUMN embedding_dimensions integer;
ALTER TABLE knowledge_chunks ADD CONSTRAINT embedding_complete CHECK (
 (embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL) OR
 (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimensions IS NOT NULL));
ALTER TABLE knowledge_chunks ADD CONSTRAINT embedding_model_configured FOREIGN KEY (embedding_model,embedding_dimensions)
 REFERENCES embedding_configuration(model,dimensions);

CREATE TABLE citations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 document_id uuid NOT NULL,
 version_id uuid NOT NULL,
 chunk_id uuid NOT NULL,
 position integer NOT NULL CHECK (position>=0),
 quote text,
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 updated_at timestamptz(3) NOT NULL DEFAULT now(),
 FOREIGN KEY (organization_id,draft_id) REFERENCES draft_responses(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY (organization_id,document_id,version_id,chunk_id)
  REFERENCES knowledge_chunks(organization_id,document_id,version_id,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE (organization_id,draft_id,position),
 UNIQUE (organization_id,draft_id,chunk_id)
);
CREATE INDEX citations_source ON citations (organization_id,document_id,version_id,chunk_id);
-- Preserve the old JSON field for rolling compatibility; only valid same-tenant
-- evidence is normalized. Untrusted historical evidence is explicitly invalidated.
INSERT INTO citations (organization_id,draft_id,document_id,version_id,chunk_id,position)
 SELECT d.organization_id,d.id,c.document_id,c.version_id,c.id,(e.n-1)::integer
 FROM draft_responses d CROSS JOIN LATERAL jsonb_array_elements(d.citations) WITH ORDINALITY AS e(value,n)
 JOIN knowledge_chunks c ON c.organization_id=d.organization_id
  AND c.id::text=e.value->>'chunkId' AND c.document_id::text=e.value->>'documentId'
  AND c.version_id::text=e.value->>'versionId'
 ON CONFLICT DO NOTHING;
UPDATE draft_responses d SET evidence_validated=false WHERE
 (SELECT count(*) FROM citations c WHERE c.organization_id=d.organization_id AND c.draft_id=d.id) <> jsonb_array_length(d.citations);
ALTER TABLE draft_responses ADD COLUMN input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens>=0);
ALTER TABLE draft_responses ADD COLUMN output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens>=0);
ALTER TABLE draft_responses ADD COLUMN variable_cost_usd numeric(12,8) NOT NULL DEFAULT 0 CHECK (variable_cost_usd>=0);

-- Lifecycle fields and trigger-maintained updated_at on mutable entities.
ALTER TABLE organizations ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE organizations ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE organizations ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE memberships ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE memberships ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE memberships ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE webhook_integrations ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE webhook_integrations ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE webhook_integrations ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE tickets ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE ticket_messages ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE ticket_messages ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE knowledge_documents ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE knowledge_documents ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE document_versions ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE document_versions ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE document_versions ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE knowledge_chunks ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE knowledge_chunks ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE draft_responses ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE draft_responses ADD COLUMN deleted_at timestamptz(3);
ALTER TABLE api_credentials ADD COLUMN created_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE api_credentials ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE idempotency_records ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE idempotency_records ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now()+interval '7 days');
CREATE INDEX idempotency_expiry ON idempotency_records (organization_id,expires_at);
CREATE INDEX audit_events_page ON audit_events (organization_id,created_at DESC,id DESC);
CREATE INDEX audit_events_resource ON audit_events (organization_id,resource_id,created_at DESC,id DESC);
CREATE INDEX credentials_membership ON api_credentials (organization_id,membership_id);
CREATE INDEX versions_live ON document_versions (organization_id,document_id,status,id) WHERE deleted_at IS NULL;
-- Exact tenant-filtered nearest-neighbor retrieval uses this B-tree before sort.
-- A global ANN index would post-filter tenants and can underfill top-k results.
CREATE INDEX chunks_retrieval ON knowledge_chunks (organization_id,document_id,version_id,id)
 WHERE deleted_at IS NULL AND embedding IS NOT NULL;
CREATE INDEX documents_live ON knowledge_documents (organization_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER organizations_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER memberships_updated BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER webhook_integrations_updated BEFORE UPDATE ON webhook_integrations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tickets_updated BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ticket_messages_updated BEFORE UPDATE ON ticket_messages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER knowledge_documents_updated BEFORE UPDATE ON knowledge_documents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER document_versions_updated BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER knowledge_chunks_updated BEFORE UPDATE ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER draft_responses_updated BEFORE UPDATE ON draft_responses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER customers_updated BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER citations_updated BEFORE UPDATE ON citations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER api_credentials_updated BEFORE UPDATE ON api_credentials FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER idempotency_records_updated BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER job_runs_updated BEFORE UPDATE ON job_runs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Compatibility write adapters allow the previous API binary to run through
-- the expansion. The columns remain until a future explicit contract migration.
CREATE FUNCTION ticket_customer_compat() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.customer_id IS NULL THEN
   INSERT INTO customers(organization_id,email) VALUES(NEW.organization_id,lower(NEW.customer_email))
    ON CONFLICT (organization_id,lower(email)) WHERE deleted_at IS NULL DO UPDATE SET email=EXCLUDED.email
    RETURNING id INTO NEW.customer_id;
  END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER ticket_customer_compat BEFORE INSERT OR UPDATE OF customer_email ON tickets
 FOR EACH ROW EXECUTE FUNCTION ticket_customer_compat();
CREATE FUNCTION version_revision_compat() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  -- Lock the parent to serialize automatic revision assignment.
  PERFORM 1 FROM knowledge_documents WHERE organization_id=NEW.organization_id AND id=NEW.document_id FOR UPDATE;
  IF NEW.revision IS NULL THEN SELECT coalesce(max(revision),0)+1 INTO NEW.revision FROM document_versions
   WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id; END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER version_revision_compat BEFORE INSERT ON document_versions
 FOR EACH ROW EXECUTE FUNCTION version_revision_compat();
CREATE FUNCTION chunk_metadata_compat() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  PERFORM 1 FROM document_versions WHERE organization_id=NEW.organization_id AND id=NEW.version_id FOR UPDATE;
  IF NEW.ordinal IS NULL THEN SELECT coalesce(max(ordinal),-1)+1 INTO NEW.ordinal FROM knowledge_chunks
   WHERE organization_id=NEW.organization_id AND version_id=NEW.version_id; END IF;
  IF NEW.content_hash IS NULL THEN NEW.content_hash=encode(sha256(convert_to(NEW.text,'UTF8')),'hex'); END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER chunk_metadata_compat BEFORE INSERT ON knowledge_chunks
 FOR EACH ROW EXECUTE FUNCTION chunk_metadata_compat();
CREATE FUNCTION sync_legacy_citations() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  DELETE FROM citations WHERE organization_id=NEW.organization_id AND draft_id=NEW.id;
  INSERT INTO citations(id,organization_id,draft_id,document_id,version_id,chunk_id,position)
   SELECT md5(NEW.id::text||':'||e.n::text)::uuid,NEW.organization_id,NEW.id,c.document_id,c.version_id,c.id,(e.n-1)::integer
   FROM jsonb_array_elements(NEW.citations) WITH ORDINALITY AS e(value,n)
   JOIN knowledge_chunks c ON c.organization_id=NEW.organization_id AND c.id::text=e.value->>'chunkId'
    AND c.document_id::text=e.value->>'documentId' AND c.version_id::text=e.value->>'versionId'
   ON CONFLICT DO NOTHING;
  IF (SELECT count(*) FROM citations WHERE organization_id=NEW.organization_id AND draft_id=NEW.id) <> jsonb_array_length(NEW.citations) THEN
   UPDATE draft_responses SET evidence_validated=false WHERE organization_id=NEW.organization_id AND id=NEW.id;
  END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER legacy_citations AFTER INSERT OR UPDATE OF citations ON draft_responses
 FOR EACH ROW EXECUTE FUNCTION sync_legacy_citations();

-- Defense in depth. Table owners/superusers are for administration only.
-- Runtime credentials must be NOSUPERUSER NOBYPASSRLS and must not own tables.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON memberships USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON customers USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_tenant ON tickets USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_messages_tenant ON ticket_messages USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_documents_tenant ON knowledge_documents USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant ON document_versions USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_chunks_tenant ON knowledge_chunks USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE draft_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY draft_responses_tenant ON draft_responses USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE citations ENABLE ROW LEVEL SECURITY;
CREATE POLICY citations_tenant ON citations USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_runs_tenant ON job_runs USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant ON audit_events USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_tenant ON idempotency_records USING (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant ON organizations USING (id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid)
 WITH CHECK (id=nullif(current_setting('resolvehub.organization_id',true),'')::uuid);
