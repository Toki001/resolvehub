-- Minimal durable storage for milestone 02 handlers. The complete domain schema,
-- runtime roles/RLS and fixture corpus are expanded in the data milestone.
CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'agent', 'analyst')),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, subject)
);

CREATE TABLE api_credentials (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE webhook_integrations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, id)
);

CREATE TABLE tickets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  customer_email text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX tickets_page ON tickets (organization_id, created_at DESC, id DESC);

CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  author text NOT NULL CHECK (author IN ('customer', 'agent')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, ticket_id) REFERENCES tickets(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_messages_parent ON ticket_messages (organization_id, ticket_id, created_at, id);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'indexed', 'failed', 'superseded')),
  active_version_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX knowledge_page ON knowledge_documents (organization_id, created_at DESC, id DESC);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  object_key text NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  UNIQUE (organization_id, document_id, id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, document_id) REFERENCES knowledge_documents(organization_id, id) ON DELETE CASCADE
);
ALTER TABLE knowledge_documents ADD CONSTRAINT active_version_owned
  FOREIGN KEY (organization_id, id, active_version_id)
  REFERENCES document_versions(organization_id, document_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  text text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, document_id, version_id)
    REFERENCES document_versions(organization_id, document_id, id) ON DELETE CASCADE
);
CREATE INDEX knowledge_chunks_parent ON knowledge_chunks (organization_id, document_id, version_id);

CREATE TABLE draft_responses (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(citations) = 'array'),
  evidence_validated boolean NOT NULL DEFAULT false,
  model text NOT NULL,
  prompt_version text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz(3),
  review_reason text,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, ticket_id) REFERENCES tickets(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, reviewed_by) REFERENCES memberships(organization_id, id),
  UNIQUE (organization_id, id)
);
CREATE INDEX drafts_parent ON draft_responses (organization_id, ticket_id, created_at DESC, id DESC);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('document_ingestion', 'draft_response', 'ticket_webhook')),
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'processing', 'succeeded', 'failed', 'cancelled')),
  resource_id uuid,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason_code text,
  request_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX job_runs_tenant_state ON job_runs (organization_id, status, created_at);

CREATE TABLE idempotency_records (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  scope text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('membership', 'integration')),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  resource_id uuid NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
