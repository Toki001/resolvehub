import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

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
  constructor(readonly kind: 'idempotency' | 'state' | 'not_found' | 'evidence') {
    super(kind);
  }
}

const ticketJson = `jsonb_build_object('id',t.id,'subject',t.subject,'customerEmail',t.customer_email,
  'status',t.status,'createdAt',t.created_at,'updatedAt',t.updated_at)`;
const draftJson = `jsonb_build_object('id',d.id,'ticketId',d.ticket_id,'text',d.text,'status',d.status,
  'revision',d.revision,'citations',d.citations,'evidenceValidated',d.evidence_validated,
  'model',d.model,'promptVersion',d.prompt_version,'reviewedBy',d.reviewed_by,
  'reviewedAt',d.reviewed_at,'reviewReason',d.review_reason,'createdAt',d.created_at)`;
const jobJson = `jsonb_build_object('id',j.id,'kind',j.kind,'status',j.status,'resourceId',j.resource_id,
  'attempts',j.attempts,'reasonCode',j.reason_code,'requestId',j.request_id,'createdAt',j.created_at,'updatedAt',j.updated_at)`;

export class ContractStore {
  constructor(readonly pool: pg.Pool) {}

  tenant(organizationId: string) {
    return new TenantRepository(this.pool, organizationId);
  }

  async authenticate(tokenHash: string): Promise<unknown> {
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT jsonb_build_object('organizationId',m.organization_id,'membershipId',m.id,
       'subject',m.subject,'role',m.role) AS data FROM api_credentials a
       JOIN memberships m ON m.id=a.membership_id AND m.organization_id=a.organization_id
       WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>now() AND m.active`,
      [tokenHash],
    );
    return result.rows[0]?.data;
  }

  async integration(id: string): Promise<unknown> {
    const result = await this.pool.query<{ data: unknown }>(
      `SELECT jsonb_build_object('id',id,'organizationId',organization_id,'encryptedSecret',encrypted_secret)
       AS data FROM webhook_integrations WHERE id=$1 AND active`,
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
    private readonly connection: pg.Pool | pg.PoolClient,
    private readonly organizationId: string,
  ) {}

  async ticket(id: string): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${ticketJson} AS data FROM tickets t WHERE t.organization_id=$1 AND t.id=$2`,
      [this.organizationId, id],
    );
    return result.rows[0]?.data;
  }

  async tickets(page: PageWindow, filter: TicketFilter): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${ticketJson} AS data FROM tickets t WHERE t.organization_id=$1
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
      'INSERT INTO tickets (id,organization_id,subject,customer_email) VALUES ($1,$2,$3,$4)',
      [id, this.organizationId, input.subject, input.customerEmail],
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
       FROM ticket_messages WHERE organization_id=$1 AND ticket_id=$2 ORDER BY created_at,id LIMIT 100`,
      [this.organizationId, ticketId],
    );
    return result.rows.map((row) => row.data);
  }

  async draft(id: string, lock = false): Promise<unknown> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${draftJson} AS data FROM draft_responses d WHERE d.organization_id=$1 AND d.id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [this.organizationId, id],
    );
    return result.rows[0]?.data;
  }

  async drafts(ticketId: string): Promise<unknown[]> {
    const result = await this.connection.query<{ data: unknown }>(
      `SELECT ${draftJson} AS data FROM draft_responses d WHERE d.organization_id=$1 AND d.ticket_id=$2
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
  }): Promise<boolean> {
    const result = await this.connection.query(
      `SELECT c.id FROM knowledge_chunks c JOIN knowledge_documents d ON d.organization_id=c.organization_id
       AND d.id=c.document_id AND d.active_version_id=c.version_id
       WHERE c.organization_id=$1 AND c.id=$2 AND c.document_id=$3 AND c.version_id=$4
       AND d.status='indexed' FOR SHARE OF c,d`,
      [this.organizationId, citation.chunkId, citation.documentId, citation.versionId],
    );
    return result.rowCount === 1;
  }

  async createIngestion(input: {
    title: string;
    objectKey: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
  }) {
    const documentId = randomUUID();
    const versionId = randomUUID();
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
  ): Promise<string> {
    const id = randomUUID();
    await this.connection.query(
      `INSERT INTO job_runs (id,organization_id,kind,resource_id,payload,request_id,replay_of)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, this.organizationId, kind, resourceId, JSON.stringify(payload), requestId, replayOf],
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

  async replay(id: string, requestId: string): Promise<string> {
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
    return this.createJob(job.kind, job.resource_id, job.payload, requestId, id);
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
       FROM knowledge_documents WHERE organization_id=$1 AND created_at<=$2::timestamptz
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
       WHERE c.organization_id=$1 AND d.status='indexed' AND strpos(lower(c.text),lower($2))>0
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
       'openTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND status='open'),
       'pendingTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND status='pending'),
       'resolvedTickets',(SELECT count(*)::int FROM tickets WHERE organization_id=$1 AND status='resolved'),
       'publishedDocuments',(SELECT count(*)::int FROM knowledge_documents WHERE organization_id=$1 AND status='indexed' AND active_version_id IS NOT NULL),
       'pendingReviews',(SELECT count(*)::int FROM draft_responses WHERE organization_id=$1 AND status='pending'),
       'acceptedJobs',(SELECT count(*)::int FROM job_runs WHERE organization_id=$1 AND status='accepted'),
       'failedJobs',(SELECT count(*)::int FROM job_runs WHERE organization_id=$1 AND status='failed')) AS data`,
      [this.organizationId],
    );
    return result.rows[0]?.data;
  }
}
