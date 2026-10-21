import { captureTraceContext } from '@resolvehub/telemetry';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { TenantConnection } from './tenant.js';
import { ticketStatus } from './ticket-status.js';

export interface Actor {
  organizationId: string;
  actorId: string;
  actorKind: 'membership' | 'integration';
  requestId: string;
}
export interface PageWindow {
  first: number;
  snapshot: string;
  last?: { createdAt: string; id: string };
}
export interface TicketFilter {
  status?: string;
  query?: string;
}
const receiptSchema = z.object({
  status: z.number(),
  body: z.json(),
  location: z.string().optional(),
});
export type MutationReceipt = z.infer<typeof receiptSchema>;
export class StoreConflict extends Error {
  constructor(readonly kind: 'idempotency' | 'state' | 'not_found' | 'evidence' | 'capacity') {
    super(kind);
  }
}

const ticketJson = `jsonb_build_object('id',t.id,'subject',t.subject,'customerEmail',t.customer_email,
  'status',t.status,'createdAt',t.created_at,'updatedAt',t.updated_at)`;
const draftJson = `jsonb_build_object('id',d.id,'ticketId',d.ticket_id,'text',d.text,'status',d.status,
  'revision',d.revision,'citations',(SELECT coalesce(jsonb_agg((jsonb_build_object('documentId',e.document_id,'versionId',e.version_id,'chunkId',e.chunk_id) || CASE WHEN e.quote IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('quote',e.quote,'reference','['||(e.position+1)::text||']') END) ORDER BY e.position),'[]'::jsonb) FROM citations e WHERE e.organization_id=d.organization_id AND e.draft_id=d.id),'evidenceValidated',d.evidence_validated,
  'model',d.model,'promptVersion',d.prompt_version,'generation',d.generation,'reviewedBy',d.reviewed_by,
  'reviewedAt',d.reviewed_at,'reviewReason',d.review_reason,'createdAt',d.created_at)`;
const jobJson = `jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'resourceId',j.resource_id,
  'attempts',j.attempts,'reasonCode',j.reason_code,'requestId',j.request_id,'createdAt',j.created_at,'updatedAt',j.updated_at)`;

export class ContractStore {
  constructor(readonly pool: pg.Pool) {}

  tenant(organizationId: string) {
    return new TenantRepository(this.pool, organizationId);
  }

  async authenticate(tokenHash: string): Promise<unknown> {
    const credential = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM api_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
      [tokenHash],
    );
    if (!credential.rows[0]) return undefined;
    const connection = new TenantConnection(this.pool, credential.rows[0].organization_id);
    const result = await connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('organizationId',m.organization_id,'membershipId',m.id,
       'subject',m.subject,'role',m.role) AS data FROM api_credentials a
       JOIN memberships m ON m.id=a.membership_id AND m.organization_id=a.organization_id
       WHERE a.token_hash=$1 AND m.organization_id=$2 AND a.revoked_at IS NULL AND a.expires_at>now() AND m.active AND m.deleted_at IS NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=m.organization_id AND o.deleted_at IS NULL)`,
      [tokenHash, credential.rows[0].organization_id],
    );
    return result.rows[0]?.data;
  }

  async integration(id: string): Promise<unknown> {
    const integration = await this.pool.query<{ organization_id: string }>(
      'SELECT organization_id FROM webhook_integrations WHERE id=$1 AND active AND deleted_at IS NULL',
      [id],
    );
    if (!integration.rows[0]) return undefined;
    const connection = new TenantConnection(this.pool, integration.rows[0].organization_id);
    const result = await connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('id',id,'organizationId',organization_id,'encryptedSecret',encrypted_secret)
       AS data FROM webhook_integrations WHERE id=$1 AND active AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=organization_id AND o.deleted_at IS NULL)`,
      [id],
    );
    return result.rows[0]?.data;
  }

  async mutate(
    actor: Actor,
    key: string,
    scope: string,
    fingerprint: string,
    action: (repository: TenantRepository) => Promise<MutationReceipt>,
  ): Promise<MutationReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('resolvehub.organization_id',$1,true)", [
        actor.organizationId,
      ]);
      // The unique insert waits for a concurrent first writer; its row lock then
      // serializes replay/conflict handling with the same business transaction.
      await client.query(
        `INSERT INTO idempotency_records (organization_id,key,scope,fingerprint)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [actor.organizationId, key, scope, fingerprint],
      );
      const existing = await client.query<{
        scope: string;
        fingerprint: string;
        response: unknown;
      }>(
        'SELECT scope,fingerprint,response FROM idempotency_records WHERE organization_id=$1 AND key=$2 FOR UPDATE',
        [actor.organizationId, key],
      );
      const record = existing.rows[0];
      if (!record) throw new Error('Missing idempotency record');
      if (record.scope !== scope || record.fingerprint !== fingerprint)
        throw new StoreConflict('idempotency');
      if (record.response !== null) {
        await client.query('COMMIT');
        return receiptSchema.parse(record.response);
      }
      const receipt = receiptSchema.parse(
        await action(new TenantRepository(client, actor.organizationId)),
      );
      await client.query(
        'UPDATE idempotency_records SET response=$3 WHERE organization_id=$1 AND key=$2',
        [actor.organizationId, key, JSON.stringify(receipt)],
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class TenantRepository {
  constructor(
    connection: pg.Pool | pg.PoolClient,
    private readonly organizationId: string,
  ) {
    this.connection =
      'totalCount' in connection ? new TenantConnection(connection, organizationId) : connection;
  }
  private readonly connection: {
    query<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<pg.QueryResult<T>>;
  };

  async ticket(id: string): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${ticketJson} AS data FROM tickets t WHERE t.organization_id=$1 AND t.id=$2 AND t.deleted_at IS NULL`,
      [this.organizationId, id],
    );
    return result.rows[0]?.data;
  }

  async tickets(page: PageWindow, filter: TicketFilter): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${ticketJson} AS data FROM tickets t WHERE t.organization_id=$1 AND t.deleted_at IS NULL
       AND t.created_at<=$2::timestamptz AND ($3::timestamptz IS NULL OR (t.created_at,t.id)<($3::timestamptz,$4::uuid))
       AND ($5::text IS NULL OR t.status=$5) AND ($6::text IS NULL OR strpos(lower(t.subject),lower($6))>0)
       ORDER BY t.created_at DESC,t.id DESC LIMIT $7`,
      [
        this.organizationId,
        page.snapshot,
        page.last?.createdAt ?? null,
        page.last?.id ?? null,
        filter.status ?? null,
        filter.query ?? null,
        page.first + 1,
      ],
    );
    return result.rows.map((row) => row.data);
  }

  async createTicket(input: {
    subject: string;
    customerEmail: string;
    message: string;
  }): Promise<unknown> {
    const id = randomUUID();
    await this.connection.query(
      'INSERT INTO tickets (id,organization_id,subject,customer_email,status) VALUES ($1,$2,$3,$4,$5)',
      [id, this.organizationId, input.subject, input.customerEmail, ticketStatus(null, 'create')],
    );
    await this.connection.query(
      `INSERT INTO ticket_messages (id,organization_id,ticket_id,body,author)
      VALUES ($1,$2,$3,$4,'customer')`,
      [randomUUID(), this.organizationId, id, input.message],
    );
    return this.ticket(id);
  }

  async messages(ticketId: string): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('id',id,'body',body,'author',author,'createdAt',created_at) AS data
       FROM ticket_messages WHERE organization_id=$1 AND ticket_id=$2 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM tickets t WHERE t.organization_id=$1 AND t.id=$2 AND t.deleted_at IS NULL) ORDER BY created_at,id LIMIT 100`,
      [this.organizationId, ticketId],
    );
    return result.rows.map((row) => row.data);
  }

  async draft(id: string, lock = false): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${draftJson} AS data FROM draft_responses d WHERE d.organization_id=$1 AND d.id=$2 AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM tickets t WHERE t.organization_id=d.organization_id AND t.id=d.ticket_id AND t.deleted_at IS NULL) ${lock ? 'FOR UPDATE' : ''}`,
      [this.organizationId, id],
    );
    return result.rows[0]?.data;
  }

  async drafts(ticketId: string): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${draftJson} AS data FROM draft_responses d WHERE d.organization_id=$1 AND d.ticket_id=$2 AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM tickets t WHERE t.organization_id=d.organization_id AND t.id=d.ticket_id AND t.deleted_at IS NULL)
       ORDER BY d.created_at DESC,d.id DESC LIMIT 100`,
      [this.organizationId, ticketId],
    );
    return result.rows.map((row) => row.data);
  }

  async review(
    id: string,
    status: 'approved' | 'rejected',
    actorId: string,
    reason: string | null,
  ): Promise<unknown> {
    await this.connection.query(
      `UPDATE draft_responses SET status=$3,reviewed_by=$4,reviewed_at=now(),
      review_reason=$5,revision=revision+1 WHERE organization_id=$1 AND id=$2`,
      [this.organizationId, id, status, actorId, reason],
    );
    return this.draft(id);
  }

  async activeCitation(citation: {
    documentId: string;
    versionId: string;
    chunkId: string;
    quote?: string;
  }): Promise<boolean> {
    const result = await this.connection.query(
      `SELECT c.id FROM knowledge_chunks c JOIN knowledge_documents d ON d.organization_id=c.organization_id
       AND d.id=c.document_id AND d.active_version_id=c.version_id
       JOIN document_versions v ON v.organization_id=c.organization_id AND v.id=c.version_id AND v.document_id=c.document_id
       WHERE c.organization_id=$1 AND c.id=$2 AND c.document_id=$3 AND c.version_id=$4
       AND d.status='indexed' AND d.deleted_at IS NULL AND c.deleted_at IS NULL
       AND ($5::text IS NULL OR strpos(c.text,$5)>0)
       AND v.status='indexed' AND v.deleted_at IS NULL FOR SHARE OF c,d,v`,
      [
        this.organizationId,
        citation.chunkId,
        citation.documentId,
        citation.versionId,
        citation.quote ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async reserveIngestion() {
    await this.connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('resolvehub:ingestion-admission',0))",
    );
    const pending = await this.connection.query<{ count: number }>(
      'SELECT ingestion_pending_count() count',
    );
    if ((pending.rows[0]?.count ?? 1000) >= 1000) throw new StoreConflict('capacity');
  }
  async failure(id: string): Promise<unknown> {
    const rows = await this.connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('jobId',f.job_id,'errorCategory',f.error_category,'summary',f.summary,'inputFingerprint',f.input_fingerprint,'requestId',f.request_id,'replayEligible',f.replay_eligible AND f.replayed_as IS NULL,'replayedAs',f.replayed_as,'failedAt',f.failed_at,'attemptHistory',coalesce((SELECT jsonb_agg(jsonb_build_object('attempt',a.attempt,'stage',a.stage,'outcome',a.outcome,'errorCategory',a.error_category,'summary',a.summary,'startedAt',a.started_at,'finishedAt',a.finished_at) ORDER BY a.attempt) FROM job_attempts a WHERE a.organization_id=f.organization_id AND a.job_id=f.job_id),'[]'::jsonb)) data FROM failed_jobs f WHERE f.organization_id=$1 AND f.job_id=$2`,
      [this.organizationId, id],
    );
    return rows.rows[0]?.data;
  }
  async createIngestion(
    input: {
      title?: string;
      objectKey: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    existingDocumentId?: string,
  ) {
    const documentId = existingDocumentId ?? randomUUID();
    const versionId = randomUUID();
    if (existingDocumentId) {
      const existing = await this.connection.query(
        'SELECT id FROM knowledge_documents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
        [this.organizationId, documentId],
      );
      if (!existing.rowCount) throw new StoreConflict('not_found');
    } else
      await this.connection.query(
        `INSERT INTO knowledge_documents (id,organization_id,title,status) VALUES ($1,$2,$3,'queued')`,
        [documentId, this.organizationId, input.title],
      );
    await this.connection.query(
      `INSERT INTO document_versions (id,organization_id,document_id,object_key,media_type,size_bytes,sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        versionId,
        this.organizationId,
        documentId,
        input.objectKey,
        input.mediaType,
        input.sizeBytes,
        input.sha256,
      ],
    );
    return { documentId, versionId };
  }

  async createJob(
    kind: string,
    resourceId: string | null,
    payload: unknown,
    requestId: string,
    replayOf: string | null = null,
    requestedBy: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await this.connection.query(
      `INSERT INTO job_runs (id,organization_id,kind,resource_id,payload,request_id,replay_of,requested_by,trace_context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        this.organizationId,
        kind,
        resourceId,
        JSON.stringify(payload),
        requestId,
        replayOf,
        requestedBy,
        JSON.stringify(captureTraceContext()),
      ],
    );
    return id;
  }

  async job(id: string): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${jobJson} AS data FROM job_runs j WHERE j.organization_id=$1 AND j.id=$2`,
      [this.organizationId, id],
    );
    return result.rows[0]?.data;
  }

  async replay(id: string, requestId: string, requestedBy: string): Promise<string> {
    const result = await this.connection.query<{
      kind: string;
      resource_id: string | null;
      payload: unknown;
      status: string;
    }>(
      'SELECT kind,resource_id,payload,status FROM job_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE',
      [this.organizationId, id],
    );
    const job = result.rows[0];
    if (!job) throw new StoreConflict('not_found');
    if (job.status !== 'failed') throw new StoreConflict('state');
    const child = await this.connection.query(
      'SELECT id FROM job_runs WHERE organization_id=$1 AND replay_of=$2',
      [this.organizationId, id],
    );
    if (child.rowCount) throw new StoreConflict('state');
    if (job.kind === 'draft_response') {
      const denied = await this.connection.query(
        'SELECT id FROM failed_jobs WHERE organization_id=$1 AND job_id=$2 AND (NOT replay_eligible OR replayed_as IS NOT NULL) FOR UPDATE',
        [this.organizationId, id],
      );
      if (denied.rowCount) throw new StoreConflict('state');
    }
    if (job.kind === 'document_ingestion') {
      const failure = await this.connection.query(
        'SELECT id FROM failed_jobs WHERE organization_id=$1 AND job_id=$2 AND replay_eligible AND replayed_as IS NULL FOR UPDATE',
        [this.organizationId, id],
      );
      if (!failure.rowCount) throw new StoreConflict('state');
      const input = z
        .object({ documentId: z.uuid(), versionId: z.uuid() })
        .strict()
        .parse(job.payload);
      const version = await this.connection.query(
        `SELECT v.id FROM document_versions v JOIN knowledge_documents d ON d.organization_id=v.organization_id AND d.id=v.document_id WHERE v.organization_id=$1 AND v.id=$2 AND d.id=$3 AND v.deleted_at IS NULL AND d.deleted_at IS NULL AND v.status='failed'`,
        [this.organizationId, input.versionId, input.documentId],
      );
      if (!version.rowCount) throw new StoreConflict('state');
      await this.reserveIngestion();
    }
    const jobId = await this.createJob(
      job.kind,
      job.resource_id,
      job.payload,
      requestId,
      id,
      requestedBy,
    );
    if (['document_ingestion', 'draft_response'].includes(job.kind))
      await this.connection.query(
        'UPDATE failed_jobs SET replayed_as=$3 WHERE organization_id=$1 AND job_id=$2',
        [this.organizationId, id, jobId],
      );
    return jobId;
  }

  async audit(actor: Actor, action: string, resourceId: string): Promise<void> {
    if (actor.organizationId !== this.organizationId) throw new Error('Audit context mismatch');
    await this.connection.query(
      `INSERT INTO audit_events (id,organization_id,actor_kind,actor_id,action,resource_id,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        this.organizationId,
        actor.actorKind,
        actor.actorId,
        action,
        resourceId,
        actor.requestId,
      ],
    );
  }

  async documents(page: PageWindow): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('id',id,'title',title,'status',status,'activeVersionId',active_version_id,'createdAt',created_at) AS data
       FROM knowledge_documents WHERE organization_id=$1 AND deleted_at IS NULL AND created_at<=$2::timestamptz
       AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $5`,
      [
        this.organizationId,
        page.snapshot,
        page.last?.createdAt ?? null,
        page.last?.id ?? null,
        page.first + 1,
      ],
    );
    return result.rows.map((row) => row.data);
  }

  async search(query: string, page: PageWindow): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object('chunkId',c.id,'documentId',d.id,'versionId',c.version_id,
        'title',d.title,'excerpt',substring(c.text,1,400),'createdAt',c.created_at) AS data
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.organization_id=c.organization_id
        AND d.id=c.document_id AND d.active_version_id=c.version_id
       WHERE c.organization_id=$1 AND d.status='indexed' AND d.deleted_at IS NULL AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM document_versions v WHERE v.organization_id=c.organization_id AND v.id=c.version_id AND v.status='indexed' AND v.deleted_at IS NULL) AND strpos(lower(c.text),lower($2))>0
        AND c.created_at<=$3::timestamptz AND ($4::timestamptz IS NULL OR (c.created_at,c.id)<($4::timestamptz,$5::uuid))
       ORDER BY c.created_at DESC,c.id DESC LIMIT $6`,
      [
        this.organizationId,
        query,
        page.snapshot,
        page.last?.createdAt ?? null,
        page.last?.id ?? null,
        page.first + 1,
      ],
    );
    return result.rows.map((row) => row.data);
  }

  async summary(): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT jsonb_build_object(
       'openTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND deleted_at IS NULL AND status='open'),
       'pendingTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND deleted_at IS NULL AND status='pending'),
       'resolvedTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND deleted_at IS NULL AND status='resolved'),
       'publishedDocuments',(SELECT count(*)::int FROM knowledge_documents d WHERE organization_id=$1 AND deleted_at IS NULL AND status='indexed' AND EXISTS (SELECT 1 FROM document_versions v WHERE v.organization_id=d.organization_id AND v.id=d.active_version_id AND v.status='indexed' AND v.deleted_at IS NULL)),
       'pendingReviews',(SELECT count(*)::int FROM draft_responses WHERE organization_id=$1 AND deleted_at IS NULL AND status='pending'),
       'acceptedJobs',(SELECT count(*)::int FROM job_runs WHERE organization_id=$1 AND status='accepted'),
       'failedJobs',(SELECT count(*)::int FROM job_runs WHERE organization_id=$1 AND status='failed')) AS data`,
      [this.organizationId],
    );
    return result.rows[0]?.data;
  }
}
