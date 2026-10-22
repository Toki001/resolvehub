import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

const jobSchema = z.object({
  createdAt: z.coerce.date(),
  availableAt: z.coerce.date(),
  id: z.uuid(),
  organizationId: z.uuid(),
  requestedBy: z.uuid().nullable(),
  payload: z.unknown(),
  requestId: z.uuid(),
});
const payloadSchema = z.object({ ticketId: z.uuid() }).strict();
export interface DraftPublication {
  text: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  generation: unknown;
  citations: readonly {
    documentId: string;
    versionId: string;
    chunkId: string;
    quote: string;
    reference: string;
  }[];
}
export class DraftSession {
  attemptNumber = 0;
  private constructor(
    private readonly client: pg.PoolClient,
    readonly job: z.infer<typeof jobSchema>,
    private readonly onError: () => void,
  ) {}
  static async open(pool: pg.Pool, organizationId: string, jobId: string) {
    z.uuid().parse(organizationId);
    z.uuid().parse(jobId);
    const client = await pool.connect(),
      onError = () => undefined;
    client.on('error', onError);
    try {
      await client.query("SELECT set_config('resolvehub.organization_id',$1,false)", [
        organizationId,
      ]);
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('resolvehub:draft:'||$1,0)) locked",
        [`${organizationId}:${jobId}`],
      );
      const rows = await client.query<{ data: unknown }>(
        "SELECT jsonb_build_object('createdAt',created_at,'availableAt',available_at,'id',id,'organizationId',organization_id,'requestedBy',requested_by,'payload',payload,'requestId',request_id) data FROM job_runs WHERE organization_id=$1 AND id=$2 AND kind='draft_response'",
        [organizationId, jobId],
      );
      if (!lock.rows[0]?.locked || !rows.rows[0]) {
        if (lock.rows[0]?.locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('resolvehub:draft:'||$1,0))",
            [`${organizationId}:${jobId}`],
          );
        await client.query('RESET resolvehub.organization_id');
        client.removeListener('error', onError);
        client.release();
        return undefined;
      }
      return new DraftSession(client, jobSchema.parse(rows.rows[0].data), onError);
    } catch (error) {
      client.removeListener('error', onError);
      client.release(true);
      throw error;
    }
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
      const result = await this.client.query<{ status: string; attempts: number; ready: boolean }>(
        'SELECT status,attempts,available_at<=now() ready FROM job_runs WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.job.organizationId, this.job.id],
      );
      const row = result.rows[0];
      if (!row || !['accepted', 'processing'].includes(row.status) || !row.ready) return 'skip';
      this.attemptNumber = row.attempts;
      await this.client.query(
        "UPDATE job_attempts SET outcome='abandoned',error_category='WORKER_INTERRUPTED',summary='Draft worker interrupted.',finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND outcome='running'",
        [this.job.organizationId, this.job.id],
      );
      if (this.attemptNumber >= 4) return 'exhausted';
      this.attemptNumber++;
      await this.client.query(
        "UPDATE job_runs SET status='processing',attempts=$3,available_at=now()+interval '150 seconds',dispatch_after=now()+interval '150 seconds' WHERE organization_id=$1 AND id=$2",
        [this.job.organizationId, this.job.id, this.attemptNumber],
      );
      await this.client.query(
        "INSERT INTO job_attempts(organization_id,job_id,attempt,stage,outcome) VALUES($1,$2,$3,'draft','running')",
        [this.job.organizationId, this.job.id, this.attemptNumber],
      );
      return 'run';
    });
  }
  async source(lock = false) {
    const input = payloadSchema.safeParse(this.job.payload);
    if (!input.success) return undefined;
    if (lock) {
      const authority = await this.client.query<{ allowed: boolean }>(
        'SELECT drafting_lock_authority($1,$2) allowed',
        [input.data.ticketId, this.job.requestedBy],
      );
      if (!authority.rows[0]?.allowed) return undefined;
    }
    const result = await this.client.query<{ ticket_id: string; question: string }>(
      `SELECT t.id ticket_id,left(t.subject||E'\\n'||coalesce((SELECT string_agg(body,E'\\n' ORDER BY created_at,id) FROM (SELECT body,created_at,id FROM ticket_messages WHERE organization_id=$1 AND ticket_id=t.id AND author='customer' AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 3) recent),''),4000) question
       FROM tickets t JOIN organizations o ON o.id=t.organization_id JOIN memberships m ON m.organization_id=t.organization_id AND m.id=$3
       WHERE t.organization_id=$1 AND t.id=$2 AND t.deleted_at IS NULL AND o.deleted_at IS NULL AND m.active AND m.deleted_at IS NULL AND m.role IN('admin','agent')`,
      [this.job.organizationId, input.data.ticketId, this.job.requestedBy],
    );
    return result.rows[0];
  }
  async usage() {
    const rows = await this.client.query<{
      input: number;
      output: number;
      cost: number;
      accounted: number;
      attempts: number;
    }>(
      `SELECT coalesce(sum((usage->>'inputTokens')::int),0)::int input,coalesce(sum((usage->>'outputTokens')::int),0)::int output,coalesce(sum((usage->>'estimatedCostUsd')::numeric),0)::float8 cost,count(usage)::int accounted,count(*)::int attempts FROM job_attempts WHERE organization_id=$1 AND job_id=$2`,
      [this.job.organizationId, this.job.id],
    );
    const result = rows.rows[0];
    if (!result) throw new Error('Usage unavailable');
    return result;
  }
  async recordUsage(usage: unknown) {
    await this.client.query(
      'UPDATE job_attempts SET usage=$4 WHERE organization_id=$1 AND job_id=$2 AND attempt=$3',
      [this.job.organizationId, this.job.id, this.attemptNumber, JSON.stringify(usage)],
    );
    return this.usage();
  }
  async complete(publication: DraftPublication, question: string) {
    return this.transaction(async () => {
      const source = await this.source(true);
      if (!source || source.question !== question) return false;
      for (const citation of publication.citations) {
        const eligible = await this.client.query(
          `SELECT c.id FROM knowledge_chunks c JOIN knowledge_documents d ON d.organization_id=c.organization_id AND d.id=c.document_id AND d.active_version_id=c.version_id JOIN document_versions v ON v.organization_id=c.organization_id AND v.id=c.version_id AND v.document_id=c.document_id
           WHERE c.organization_id=$1 AND c.id=$2 AND c.document_id=$3 AND c.version_id=$4 AND c.deleted_at IS NULL AND d.deleted_at IS NULL AND v.deleted_at IS NULL AND d.status='indexed' AND v.status='indexed' AND strpos(c.text,$5)>0 FOR SHARE OF c,d,v`,
          [
            this.job.organizationId,
            citation.chunkId,
            citation.documentId,
            citation.versionId,
            citation.quote,
          ],
        );
        if (eligible.rowCount !== 1) return false;
      }
      await this.client.query(
        `INSERT INTO draft_responses(id,organization_id,ticket_id,text,citations,evidence_validated,model,prompt_version,input_tokens,output_tokens,variable_cost_usd,generation,source_job_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$1) ON CONFLICT(organization_id,source_job_id) DO NOTHING`,
        [
          this.job.id,
          this.job.organizationId,
          source.ticket_id,
          publication.text,
          JSON.stringify(publication.citations),
          publication.citations.length > 0,
          publication.model,
          publication.promptVersion,
          publication.inputTokens,
          publication.outputTokens,
          publication.estimatedCostUsd,
          JSON.stringify(publication.generation),
        ],
      );
      for (const citation of publication.citations)
        await this.client.query(
          'UPDATE citations SET quote=$4 WHERE organization_id=$1 AND draft_id=$2 AND chunk_id=$3',
          [this.job.organizationId, this.job.id, citation.chunkId, citation.quote],
        );
      await this.client.query(
        "INSERT INTO audit_events(id,organization_id,actor_kind,actor_id,action,resource_id,request_id) VALUES(gen_random_uuid(),$1,'membership',$2,'draft.generated',$3,$4)",
        [this.job.organizationId, this.job.requestedBy, this.job.id, this.job.requestId],
      );
      await this.client.query(
        "UPDATE job_attempts SET outcome='succeeded',finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND attempt=$3",
        [this.job.organizationId, this.job.id, this.attemptNumber],
      );
      await this.client.query(
        "UPDATE job_runs SET status='succeeded',reason_code=NULL,resource_id=$2 WHERE organization_id=$1 AND id=$2",
        [this.job.organizationId, this.job.id],
      );
      return true;
    });
  }
  async fail(category: string, permanent: boolean, delayMs: number, replayEligible = !permanent) {
    const terminal = permanent || this.attemptNumber >= 4;
    await this.transaction(async () => {
      await this.client.query(
        'UPDATE job_attempts SET outcome=$4,error_category=$5,summary=$6,finished_at=now() WHERE organization_id=$1 AND job_id=$2 AND attempt=$3',
        [
          this.job.organizationId,
          this.job.id,
          this.attemptNumber,
          permanent ? 'permanent' : 'transient',
          category,
          `Draft processing failed: ${category}.`,
        ],
      );
      await this.client.query(
        "UPDATE job_runs SET status=$3,reason_code=$4,available_at=now()+($5::double precision*interval '1 millisecond'),dispatch_after=now() WHERE organization_id=$1 AND id=$2",
        [this.job.organizationId, this.job.id, terminal ? 'failed' : 'accepted', category, delayMs],
      );
      if (terminal)
        await this.client.query(
          'INSERT INTO failed_jobs(id,organization_id,job_id,error_category,summary,input_fingerprint,request_id,replay_eligible) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,job_id) DO NOTHING',
          [
            this.job.organizationId,
            this.job.id,
            category,
            `Draft processing failed: ${category}.`,
            createHash('sha256').update(JSON.stringify(this.job.payload)).digest('hex'),
            this.job.requestId,
            replayEligible,
          ],
        );
    });
    return terminal;
  }
  async close() {
    let discard = false;
    try {
      await this.client.query(
        "SELECT pg_advisory_unlock(hashtextextended('resolvehub:draft:'||$1,0))",
        [`${this.job.organizationId}:${this.job.id}`],
      );
      await this.client.query('RESET resolvehub.organization_id');
    } catch {
      discard = true;
    }
    this.client.removeListener('error', this.onError);
    this.client.release(discard);
  }
}
