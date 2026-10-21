import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { PgTableExtraConfigValue, AnyPgColumn } from 'drizzle-orm/pg-core';
import { EMBEDDING_DIMENSIONS } from './embedding.js';

const created = () =>
  timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull();
const updated = () =>
  timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull();
const deleted = () => timestamp('deleted_at', { withTimezone: true, precision: 3 });
const lifecycle = () => ({ createdAt: created(), updatedAt: updated(), deletedAt: deleted() });
const tenantPolicy = (name: string, column: AnyPgColumn) => {
  const predicate = sql`${column}=nullif(current_setting('resolvehub.organization_id',true),'')::uuid`;
  return pgPolicy(name, { using: predicate, withCheck: predicate });
};
export const organizations = pgTable(
  'organizations',
  { id: uuid().primaryKey(), name: text().notNull(), ...lifecycle() },
  (t) => [
    tenantPolicy('organizations_tenant', t.id),
    check('organizations_name_check', sql`length(${t.name}) between 1 and 200`),
  ],
).enableRLS();
export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subject: text().notNull(),
    role: text({ enum: ['admin', 'agent', 'analyst'] }).notNull(),
    active: boolean().default(true).notNull(),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('memberships_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.subject),
    check('memberships_role_check', sql`${t.role} in ('admin','agent','analyst')`),
  ],
).enableRLS();
export const apiCredentials = pgTable(
  'api_credentials',
  {
    tokenHash: text('token_hash').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    index('credentials_membership').on(t.organizationId, t.membershipId),
    check('api_credentials_token_hash_check', sql`length(${t.tokenHash})=64`),
  ],
);
export const webhookIntegrations = pgTable(
  'webhook_integrations',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    encryptedSecret: text('encrypted_secret').notNull(),
    active: boolean().default(true).notNull(),
    ...lifecycle(),
  },
  (t) => [unique().on(t.organizationId, t.id)],
);
export const customers = pgTable(
  'customers',
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    displayName: text('display_name').default('').notNull(),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('customers_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    uniqueIndex('customers_email_live')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
    index('customers_page')
      .on(t.organizationId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} is null`),
  ],
).enableRLS();
export const tickets = pgTable(
  'tickets',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    subject: text().notNull(),
    status: text({ enum: ['open', 'pending', 'resolved'] })
      .default('open')
      .notNull(),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('tickets_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    foreignKey({
      name: 'tickets_customer_owned',
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
    }),
    index('tickets_page').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('tickets_state_page').on(t.organizationId, t.status, t.createdAt.desc(), t.id.desc()),
    index('tickets_customer').on(t.organizationId, t.customerId, t.createdAt.desc(), t.id.desc()),
    check('tickets_status_check', sql`${t.status} in ('open','pending','resolved')`),
    check('tickets_subject_check', sql`length(${t.subject}) between 1 and 200`),
  ],
).enableRLS();
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    body: text().notNull(),
    author: text({ enum: ['customer', 'agent'] }).notNull(),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('ticket_messages_tenant', t.organizationId),
    foreignKey({
      columns: [t.organizationId, t.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }).onDelete('cascade'),
    index('ticket_messages_parent').on(t.organizationId, t.ticketId, t.createdAt, t.id),
    check('ticket_messages_body_check', sql`length(${t.body}) between 1 and 20000`),
    check('ticket_messages_author_check', sql`${t.author} in ('customer','agent')`),
  ],
).enableRLS();
const versionStates = [
  'uploaded',
  'queued',
  'processing',
  'indexed',
  'failed',
  'superseded',
] as const;
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    status: text({ enum: versionStates }).notNull(),
    activeVersionId: uuid('active_version_id'),
    ...lifecycle(),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantPolicy('knowledge_documents_tenant', t.organizationId),
    foreignKey({
      name: 'active_version_owned',
      columns: [t.organizationId, t.id, t.activeVersionId],
      foreignColumns: [
        documentVersions.organizationId,
        documentVersions.documentId,
        documentVersions.id,
      ],
    }),
    unique().on(t.organizationId, t.id),
    index('knowledge_page').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('documents_live')
      .on(t.organizationId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} is null`),
    check(
      'knowledge_documents_status_check',
      sql`${t.status} in ('uploaded','queued','processing','indexed','failed','superseded')`,
    ),
  ],
).enableRLS();
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    objectKey: text('object_key').notNull(),
    mediaType: text('media_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text().notNull(),
    status: text({ enum: versionStates }).default('queued').notNull(),
    revision: integer().notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true, precision: 3 }),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('document_versions_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    unique().on(t.organizationId, t.documentId, t.id),
    unique('document_revision_unique').on(t.organizationId, t.documentId, t.revision),
    foreignKey({
      columns: [t.organizationId, t.documentId],
      foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id],
    }).onDelete('cascade'),
    index('versions_live')
      .on(t.organizationId, t.documentId, t.status, t.id)
      .where(sql`${t.deletedAt} is null`),
    check('document_revision_positive', sql`${t.revision}>0`),
    check(
      'document_versions_status_check',
      sql`${t.status} in ('uploaded','queued','processing','indexed','failed','superseded')`,
    ),
    check('document_versions_size_bytes_check', sql`${t.sizeBytes} between 1 and 10485760`),
    check('document_versions_sha256_check', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
).enableRLS();
export const embeddingConfiguration = pgTable(
  'embedding_configuration',
  {
    singleton: boolean().primaryKey().default(true),
    model: text().notNull(),
    dimensions: integer().notNull(),
  },
  (t) => [
    unique().on(t.model, t.dimensions),
    check('embedding_configuration_singleton_check', sql`${t.singleton}`),
    check('embedding_configuration_dimensions_check', sql`${t.dimensions}=64`),
  ],
);
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    ordinal: integer().notNull(),
    text: text().notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    embeddingDimensions: integer('embedding_dimensions'),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('knowledge_chunks_tenant', t.organizationId),
    unique('chunk_position_unique').on(t.organizationId, t.versionId, t.ordinal),
    unique('chunk_evidence_identity').on(t.organizationId, t.documentId, t.versionId, t.id),
    foreignKey({
      columns: [t.organizationId, t.documentId, t.versionId],
      foreignColumns: [
        documentVersions.organizationId,
        documentVersions.documentId,
        documentVersions.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'embedding_model_configured',
      columns: [t.embeddingModel, t.embeddingDimensions],
      foreignColumns: [embeddingConfiguration.model, embeddingConfiguration.dimensions],
    }),
    index('knowledge_chunks_parent').on(t.organizationId, t.documentId, t.versionId),
    index('chunks_retrieval')
      .on(t.organizationId, t.documentId, t.versionId, t.id)
      .where(sql`${t.deletedAt} is null and ${t.embedding} is not null`),
    check('chunk_ordinal_positive', sql`${t.ordinal}>=0`),
    check('chunk_hash_valid', sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'embedding_complete',
      sql`(${t.embedding} is null and ${t.embeddingModel} is null and ${t.embeddingDimensions} is null) or (${t.embedding} is not null and ${t.embeddingModel} is not null and ${t.embeddingDimensions} is not null)`,
    ),
  ],
).enableRLS();
export const draftResponses = pgTable(
  'draft_responses',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    ticketId: uuid('ticket_id').notNull(),
    text: text().notNull(),
    status: text({ enum: ['pending', 'approved', 'rejected'] })
      .default('pending')
      .notNull(),
    revision: integer().default(1).notNull(),
    citations: jsonb()
      .$type<ReadonlyArray<{ documentId: string; versionId: string; chunkId: string }>>()
      .default([])
      .notNull(),
    evidenceValidated: boolean('evidence_validated').default(false).notNull(),
    model: text().notNull(),
    promptVersion: text('prompt_version').notNull(),
    generation: jsonb().$type<unknown>(),
    sourceJobId: uuid('source_job_id'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, precision: 3 }),
    reviewReason: text('review_reason'),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    variableCostUsd: numeric('variable_cost_usd', { precision: 12, scale: 8 })
      .default('0')
      .notNull(),
    ...lifecycle(),
  },
  (t) => [
    tenantPolicy('draft_responses_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    foreignKey({
      columns: [t.organizationId, t.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.reviewedBy],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceJobId],
      foreignColumns: [jobRuns.organizationId, jobRuns.id],
    }),
    unique('draft_source_job_unique').on(t.organizationId, t.sourceJobId),
    index('drafts_parent').on(t.organizationId, t.ticketId, t.createdAt.desc(), t.id.desc()),
    check('draft_responses_status_check', sql`${t.status} in ('pending','approved','rejected')`),
    check('draft_responses_revision_check', sql`${t.revision}>0`),
    check('draft_responses_citations_check', sql`jsonb_typeof(${t.citations})='array'`),
    check('draft_responses_input_tokens_check', sql`${t.inputTokens}>=0`),
    check('draft_responses_output_tokens_check', sql`${t.outputTokens}>=0`),
    check('draft_responses_variable_cost_usd_check', sql`${t.variableCostUsd}>=0`),
  ],
).enableRLS();
export const citations = pgTable(
  'citations',
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    position: integer().notNull(),
    quote: text(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    tenantPolicy('citations_tenant', t.organizationId),
    foreignKey({
      columns: [t.organizationId, t.draftId],
      foreignColumns: [draftResponses.organizationId, draftResponses.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.documentId, t.versionId, t.chunkId],
      foreignColumns: [
        knowledgeChunks.organizationId,
        knowledgeChunks.documentId,
        knowledgeChunks.versionId,
        knowledgeChunks.id,
      ],
    }),
    unique().on(t.organizationId, t.draftId, t.position),
    unique().on(t.organizationId, t.draftId, t.chunkId),
    index('citations_source').on(t.organizationId, t.documentId, t.versionId, t.chunkId),
    check('citations_position_check', sql`${t.position}>=0`),
  ],
).enableRLS();
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['document_ingestion', 'draft_response', 'ticket_webhook'] }).notNull(),
    status: text({ enum: ['accepted', 'processing', 'succeeded', 'failed', 'cancelled'] })
      .default('accepted')
      .notNull(),
    resourceId: uuid('resource_id'),
    payload: jsonb().notNull(),
    attempts: integer().default(0).notNull(),
    reasonCode: text('reason_code'),
    requestId: uuid('request_id').notNull(),
    traceContext: jsonb('trace_context').$type<{ traceparent?: string }>().notNull().default({}),
    replayOf: uuid('replay_of'),
    requestedBy: uuid('requested_by'),
    availableAt: timestamp('available_at', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    dispatchAfter: timestamp('dispatch_after', { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    tenantPolicy('job_runs_tenant', t.organizationId),
    unique().on(t.organizationId, t.id),
    unique('one_replay_per_failed_job').on(t.organizationId, t.replayOf),
    foreignKey({
      name: 'job_replay_parent',
      columns: [t.organizationId, t.replayOf],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      name: 'job_requester_owned',
      columns: [t.organizationId, t.requestedBy],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('ingestion_dispatch')
      .on(t.availableAt, t.dispatchAfter, t.createdAt, t.id)
      .where(sql`${t.kind}='document_ingestion' and ${t.status} in ('accepted','processing')`),
    uniqueIndex('one_live_ingestion_version')
      .on(t.organizationId, sql`(${t.payload}->>'versionId')`)
      .where(sql`${t.kind}='document_ingestion' and ${t.status} in ('accepted','processing')`),
    index('job_runs_tenant_state').on(t.organizationId, t.status, t.createdAt),
    check('replay_is_distinct', sql`${t.replayOf} is null or ${t.replayOf}<>${t.id}`),
    check('job_runs_attempts_check', sql`${t.attempts}>=0`),
    check(
      'job_trace_context_safe',
      sql`jsonb_typeof(${t.traceContext})='object' and ${t.traceContext}-'traceparent'='{}'::jsonb and (not ${t.traceContext} ? 'traceparent' or jsonb_typeof(${t.traceContext}->'traceparent')='string' and length(${t.traceContext}->>'traceparent')=55 and ${t.traceContext}->>'traceparent' ~ '^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$')`,
    ),
    check(
      'job_runs_kind_check',
      sql`${t.kind} in ('document_ingestion','draft_response','ticket_webhook')`,
    ),
    check(
      'job_runs_status_check',
      sql`${t.status} in ('accepted','processing','succeeded','failed','cancelled')`,
    ),
  ],
).enableRLS();
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    scope: text().notNull(),
    fingerprint: text().notNull(),
    response: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: updated(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .default(sql`now()+interval '7 days'`)
      .notNull(),
  },
  (t) => [
    tenantPolicy('idempotency_records_tenant', t.organizationId),
    primaryKey({ columns: [t.organizationId, t.key] }),
    index('idempotency_expiry').on(t.organizationId, t.expiresAt),
  ],
).enableRLS();
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorKind: text('actor_kind', { enum: ['membership', 'integration'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    action: text().notNull(),
    resourceId: uuid('resource_id').notNull(),
    requestId: uuid('request_id').notNull(),
    createdAt: created(),
  },
  (t) => [
    tenantPolicy('audit_events_tenant', t.organizationId),
    index('audit_events_page').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('audit_events_resource').on(
      t.organizationId,
      t.resourceId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    check('audit_events_actor_kind_check', sql`${t.actorKind} in ('membership','integration')`),
  ],
).enableRLS();

export const jobAttempts = pgTable(
  'job_attempts',
  {
    organizationId: uuid('organization_id').notNull(),
    jobId: uuid('job_id').notNull(),
    attempt: integer().notNull(),
    stage: text().notNull(),
    outcome: text({
      enum: ['running', 'succeeded', 'transient', 'permanent', 'abandoned'],
    }).notNull(),
    errorCategory: text('error_category'),
    summary: text(),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    usage: jsonb().$type<unknown>(),
    finishedAt: timestamp('finished_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [
    tenantPolicy('job_attempts_tenant', t.organizationId),
    primaryKey({ columns: [t.organizationId, t.jobId, t.attempt] }),
    foreignKey({
      columns: [t.organizationId, t.jobId],
      foreignColumns: [jobRuns.organizationId, jobRuns.id],
    }).onDelete('cascade'),
    check('job_attempts_attempt_check', sql`${t.attempt} between 1 and 4`),
    check(
      'job_attempts_outcome_check',
      sql`${t.outcome} in ('running','succeeded','transient','permanent','abandoned')`,
    ),
  ],
).enableRLS();
export const ingestionArtifacts = pgTable(
  'ingestion_artifacts',
  {
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    versionId: uuid('version_id').notNull(),
    fingerprint: text().notNull(),
    extractedText: text('extracted_text').notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    createdAt: created(),
  },
  (t) => [
    tenantPolicy('ingestion_artifacts_tenant', t.organizationId),
    primaryKey({ columns: [t.organizationId, t.documentId, t.versionId] }),
    foreignKey({
      columns: [t.organizationId, t.documentId, t.versionId],
      foreignColumns: [
        documentVersions.organizationId,
        documentVersions.documentId,
        documentVersions.id,
      ],
    }).onDelete('cascade'),
    check('ingestion_artifacts_fingerprint_check', sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`),
    check(
      'ingestion_artifacts_extracted_text_check',
      sql`length(${t.extractedText}) between 1 and 200000`,
    ),
  ],
).enableRLS();
export const failedJobs = pgTable(
  'failed_jobs',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    jobId: uuid('job_id').notNull(),
    errorCategory: text('error_category').notNull(),
    summary: text().notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    requestId: uuid('request_id').notNull(),
    replayEligible: boolean('replay_eligible').notNull(),
    replayedAs: uuid('replayed_as'),
    failedAt: timestamp('failed_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    tenantPolicy('failed_jobs_tenant', t.organizationId),
    unique().on(t.organizationId, t.jobId),
    foreignKey({
      columns: [t.organizationId, t.jobId],
      foreignColumns: [jobRuns.organizationId, jobRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.replayedAs],
      foreignColumns: [jobRuns.organizationId, jobRuns.id],
    }),
    index('failed_jobs_page').on(t.organizationId, t.failedAt.desc(), t.id.desc()),
  ],
).enableRLS();
