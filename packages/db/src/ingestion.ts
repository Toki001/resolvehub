import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, validateVector } from './embedding.js';

const payloadSchema = z.object({ documentId: z.uuid(), versionId: z.uuid() }).strict();
const jobSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  status: z.string(),
  attempts: z.number().int(),
  requestId: z.uuid(),
  requestedBy: z.uuid().nullable(),
  payload: z.unknown(),
  ready: z.boolean(),
});
const sourceSchema = z.object({
  documentId: z.uuid(),
  versionId: z.uuid(),
  objectKey: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  revision: z.number().int(),
  authorized: z.boolean(),
});
export type IngestionSource = z.infer<typeof sourceSchema>;
export interface IndexedChunk {
  id: string;
  ordinal: number;
  text: string;
  contentHash: string;
}
export interface IngestionFailureRecord {
  category: string;
  summary: string;
  permanent: boolean;
  replayEligible: boolean;
  delayMs: number;
}
export const PIPELINE_VERSION = 'text-v1-chunk1000-overlap100';

export class IngestionSession {
  private attempt = 0;
  readonly payload;
  readonly fingerprint: string;
  private constructor(
    private readonly client: pg.PoolClient,
    readonly job: z.infer<typeof jobSchema>,
    private readonly lockKey: string,
    private readonly connectionError: () => void,
  ) {
    this.payload = payloadSchema.safeParse(job.payload);
    this.fingerprint = createHash('sha256').update(JSON.stringify(job.payload)).digest('hex');
  }
  static async open(pool: pg.Pool, organizationId: string, jobId: string) {
    z.uuid().parse(organizationId);
    z.uuid().parse(jobId);
    const client = await pool.connect();
    const connectionError = () => undefined;
    client.on('error', connectionError);
    try {
      await client.query("SELECT set_config('resolvehub.organization_id',$1,false)", [
        organizationId,
      ]);
      const row = await client.query<{ data: unknown }>(
        `SELECT jsonb_build_object('id',id,'organizationId',organization_id,'status',status,'attempts',attempts,'requestId',request_id,'requestedBy',requested_by,'payload',payload,'ready',available_at<=now()) data FROM job_runs WHERE organization_id=$1 AND id=$2 AND kind='document_ingestion'`,
        [organizationId, jobId],
      );
      if (!row.rows[0]) {
        await client.query('RESET resolvehub.organization_id');
        client.removeListener('error', connectionError);
        client.release();
        return undefined;
      }
      const job = jobSchema.parse(row.rows[0].data),
        payload = payloadSchema.safeParse(job.payload);
      const key = payload.success
        ? `${organizationId}:${payload.data.documentId}:${payload.data.versionId}`
        : `${organizationId}:${jobId}`;
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',
        [`resolvehub:index:${key}`],
      );
      if (!lock.rows[0]?.locked) {
        await client.query('RESET resolvehub.organization_id');
        client.removeListener('error', connectionError);
        client.release();
        return undefined;
      }
      return new IngestionSession(client, job, `resolvehub:index:${key}`, connectionError);
    } catch (error) {
      client.removeListener('error', connectionError);
      client.release(true);
      throw error;
    }
  }
  private query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ) {
    return this.client.query<T>(sql, [this.job.organizationId, ...values]);
  }
  private async transaction<T>(action: () => Promise<T>) {
    await this.client.query('BEGIN');
    try {
      const result = await action();
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
  async claim() {
    return this.transaction(async () => {
      const row = await this.query<{ status: string; attempts: number; ready: boolean }>(
        'SELECT status,attempts,available_at<=now() ready FROM job_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.job.id],
      );
      const job = row.rows[0];
      if (!job || !['accepted', 'processing'].includes(job.status) || !job.ready)
        return 'skip' as const;
      await this.query(
        "UPDATE job_attempts SET outcome='abandoned',error_category='WORKER_INTERRUPTED',summary='Worker stopped before completing the attempt.',finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND outcome='running'",
        [this.job.id],
      );
      this.attempt = job.attempts;
      if (this.attempt >= 4) return 'exhausted' as const;
      this.attempt++;
      await this.query(
        "UPDATE job_runs SET status='processing',attempts=$3,available_at=now()+interval '150 seconds',dispatch_after=now()+interval '150 seconds' WHERE organization_id=$1 AND id=$2",
        [this.job.id, this.attempt],
      );
      await this.query(
        "INSERT INTO job_attempts(organization_id,job_id,attempt,stage,outcome) VALUES($1,$2,$3,'validate','running')",
        [this.job.id, this.attempt],
      );
      return 'run' as const;
    });
  }
  get attemptNumber() {
    return this.attempt;
  }
  async stage(stage: string) {
    await this.query(
      "UPDATE job_attempts SET stage=$4 WHERE organization_id=$1 AND job_id=$2 AND attempt=$3 AND outcome='running'",
      [this.job.id, this.attempt, stage],
    );
  }
  async source() {
    if (!this.payload.success) return undefined;
    const { documentId, versionId } = this.payload.data;
    const rows = await this.query<{ data: unknown }>(
      `SELECT jsonb_build_object('documentId',d.id,'versionId',v.id,'objectKey',v.object_key,'mediaType',v.media_type,'sizeBytes',v.size_bytes,'sha256',v.sha256,'revision',v.revision,
      'authorized',EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=d.organization_id AND m.id=$4 AND m.active AND m.deleted_at IS NULL AND m.role IN ('admin','agent'))) data
      FROM document_versions v JOIN knowledge_documents d ON d.organization_id=v.organization_id AND d.id=v.document_id JOIN organizations o ON o.id=d.organization_id
      WHERE v.organization_id=$1 AND d.id=$2 AND v.id=$3 AND d.deleted_at IS NULL AND v.deleted_at IS NULL AND o.deleted_at IS NULL`,
      [documentId, versionId, this.job.requestedBy],
    );
    if (!rows.rows[0]) return undefined;
    return sourceSchema.parse(rows.rows[0].data);
  }
  async extraction() {
    if (!this.payload.success) return undefined;
    const rows = await this.query<{ text: string }>(
      `SELECT extracted_text text FROM ingestion_artifacts WHERE organization_id=$1 AND document_id=$2 AND version_id=$3 AND fingerprint=$4 AND pipeline_version=$5`,
      [
        this.payload.data.documentId,
        this.payload.data.versionId,
        this.fingerprint,
        PIPELINE_VERSION,
      ],
    );
    return rows.rows[0]?.text;
  }
  async saveExtraction(text: string) {
    if (!this.payload.success) throw new Error('Invalid ingestion state');
    await this.query(
      `INSERT INTO ingestion_artifacts(organization_id,document_id,version_id,fingerprint,extracted_text,pipeline_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        this.payload.data.documentId,
        this.payload.data.versionId,
        this.fingerprint,
        text,
        PIPELINE_VERSION,
      ],
    );
  }
  async stageChunks(chunks: readonly IndexedChunk[]) {
    if (!this.payload.success) throw new Error('Invalid ingestion state');
    const { documentId, versionId } = this.payload.data;
    await this.transaction(async () => {
      for (const c of chunks)
        await this.query(
          `INSERT INTO knowledge_chunks(id,organization_id,document_id,version_id,ordinal,text,content_hash) VALUES($2,$1,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,version_id,ordinal) DO NOTHING`,
          [c.id, documentId, versionId, c.ordinal, c.text, c.contentHash],
        );
      const rows = await this.query<{ id: string; content_hash: string; ordinal: number }>(
        'SELECT id,content_hash,ordinal FROM knowledge_chunks WHERE organization_id=$1 AND version_id=$2 AND deleted_at IS NULL ORDER BY ordinal',
        [versionId],
      );
      if (
        rows.rows.length !== chunks.length ||
        rows.rows.some(
          (row, i) => row.id !== chunks[i]?.id || row.content_hash !== chunks[i]?.contentHash,
        )
      )
        throw new Error('Checkpoint integrity mismatch');
      await this.query(
        "UPDATE document_versions SET status='processing' WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
        [versionId],
      );
      await this.query(
        "UPDATE knowledge_documents SET status='processing' WHERE organization_id=$1 AND id=$2 AND active_version_id IS NULL AND deleted_at IS NULL",
        [documentId],
      );
    });
  }
  async pendingEmbeddings() {
    if (!this.payload.success) return [];
    const rows = await this.query<{ id: string; text: string }>(
      'SELECT id,text FROM knowledge_chunks WHERE organization_id=$1 AND version_id=$2 AND embedding IS NULL AND deleted_at IS NULL ORDER BY ordinal LIMIT 16',
      [this.payload.data.versionId],
    );
    return rows.rows;
  }
  async saveEmbeddings(rows: readonly { id: string; embedding: readonly number[] }[]) {
    if (!this.payload.success) throw new Error('Invalid ingestion state');
    const versionId = this.payload.data.versionId;
    await this.transaction(async () => {
      for (const row of rows)
        await this.query(
          'UPDATE knowledge_chunks SET embedding=$4::public.vector,embedding_model=$5,embedding_dimensions=$6 WHERE organization_id=$1 AND version_id=$2 AND id=$3 AND embedding IS NULL',
          [
            versionId,
            row.id,
            JSON.stringify(validateVector(row.embedding)),
            EMBEDDING_MODEL,
            EMBEDDING_DIMENSIONS,
          ],
        );
    });
  }
  async complete() {
    if (!this.payload.success) throw new Error('Invalid ingestion state');
    const { documentId, versionId } = this.payload.data;
    return this.transaction(async () => {
      const doc = await this.query<{ active_version_id: string | null }>(
        'SELECT active_version_id FROM knowledge_documents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
        [documentId],
      );
      if (!doc.rows[0]) return false;
      const source = await this.source();
      if (!source || !source.authorized) return false;
      const versions = await this.query<{ id: string; revision: number; status: string }>(
        'SELECT id,revision,status FROM document_versions WHERE organization_id=$1 AND document_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [documentId],
      );
      const previous = versions.rows.find((v) => v.id === doc.rows[0]?.active_version_id);
      if (previous && previous.id !== versionId && previous.revision >= source.revision)
        return false;
      const count = await this.query<{ total: number; ready: number }>(
        'SELECT count(*)::int total,count(*) FILTER(WHERE embedding IS NOT NULL AND embedding_model=$3)::int ready FROM knowledge_chunks WHERE organization_id=$1 AND version_id=$2 AND deleted_at IS NULL',
        [versionId, EMBEDDING_MODEL],
      );
      if (!count.rows[0]?.total || count.rows[0].total !== count.rows[0].ready)
        throw new Error('Incomplete index');
      if (previous && previous.id !== versionId)
        await this.query(
          "UPDATE document_versions SET status='superseded' WHERE organization_id=$1 AND id=$2",
          [previous.id],
        );
      await this.query(
        "UPDATE document_versions SET status='indexed',indexed_at=coalesce(indexed_at,now()) WHERE organization_id=$1 AND id=$2",
        [versionId],
      );
      await this.query(
        "UPDATE knowledge_documents SET active_version_id=$3,status='indexed' WHERE organization_id=$1 AND id=$2",
        [documentId, versionId],
      );
      await this.query(
        "UPDATE job_runs SET status='succeeded',reason_code=NULL WHERE organization_id=$1 AND id=$2",
        [this.job.id],
      );
      await this.query(
        "UPDATE job_attempts SET stage='publish',outcome='succeeded',finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND attempt=$3",
        [this.job.id, this.attempt],
      );
      await this.query(
        `INSERT INTO audit_events(id,organization_id,actor_kind,actor_id,action,resource_id,request_id) VALUES($2,$1,'membership',$3,'document.indexed',$4,$5)`,
        [randomUUID(), this.job.requestedBy, versionId, this.job.requestId],
      );
      return true;
    });
  }
  async fail(failure: IngestionFailureRecord) {
    const terminal = failure.permanent || this.attempt >= 4;
    await this.transaction(async () => {
      await this.query(
        'UPDATE job_attempts SET outcome=$4,error_category=$5,summary=$6,finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND attempt=$3',
        [
          this.job.id,
          this.attempt,
          failure.category === 'WORKER_INTERRUPTED'
            ? 'abandoned'
            : failure.permanent
              ? 'permanent'
              : 'transient',
          failure.category,
          failure.summary,
        ],
      );
      await this.query(
        "UPDATE job_runs SET status=$3,reason_code=$4,available_at=now()+($5::double precision*interval '1 millisecond'),dispatch_after=now() WHERE organization_id=$1 AND id=$2",
        [this.job.id, terminal ? 'failed' : 'accepted', failure.category, failure.delayMs],
      );
      if (terminal) {
        if (this.payload.success) {
          await this.query(
            "UPDATE document_versions SET status='failed' WHERE organization_id=$1 AND id=$2 AND status<>'indexed' AND deleted_at IS NULL",
            [this.payload.data.versionId],
          );
          await this.query(
            "UPDATE knowledge_documents SET status='failed' WHERE organization_id=$1 AND id=$2 AND active_version_id IS NULL AND deleted_at IS NULL",
            [this.payload.data.documentId],
          );
        }
        await this.query(
          `INSERT INTO failed_jobs(id,organization_id,job_id,error_category,summary,input_fingerprint,request_id,replay_eligible) VALUES($2,$1,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,job_id) DO NOTHING`,
          [
            randomUUID(),
            this.job.id,
            failure.category,
            failure.summary,
            this.fingerprint,
            this.job.requestId,
            failure.replayEligible,
          ],
        );
      }
    });
    return terminal;
  }
  async close() {
    let discard = false;
    try {
      await this.client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [this.lockKey]);
      await this.client.query('RESET resolvehub.organization_id');
    } catch {
      discard = true;
    }
    this.client.removeListener('error', this.connectionError);
    this.client.release(discard);
  }
}
