import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type pg from 'pg';
import { z } from 'zod';
import { EMBEDDING_MODEL, validateVector } from './embedding.js';
import { auditEvents, documentVersions, knowledgeChunks, knowledgeDocuments } from './schema.js';
import { tenantDrizzle } from './tenant.js';
import type { Actor } from './store.js';
import { StoreConflict } from './store.js';

export class KnowledgeRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly organizationId: string,
  ) {
    z.uuid().parse(organizationId);
  }

  // Exact search deliberately materializes the tenant's published candidates
  // BEFORE distance ranking. The partial tenant B-tree bounds candidate loading.
  async nearest(embedding: readonly number[], first = 5) {
    const vector = validateVector(embedding);
    z.number().int().min(1).max(100).parse(first);
    return tenantDrizzle(this.pool, this.organizationId, async (db) => {
      const candidates = db
        .select({
          id: knowledgeChunks.id,
          documentId: knowledgeChunks.documentId,
          versionId: knowledgeChunks.versionId,
          text: knowledgeChunks.text,
          embedding: knowledgeChunks.embedding,
        })
        .from(knowledgeChunks)
        .innerJoin(
          knowledgeDocuments,
          and(
            eq(knowledgeDocuments.organizationId, knowledgeChunks.organizationId),
            eq(knowledgeDocuments.id, knowledgeChunks.documentId),
            eq(knowledgeDocuments.activeVersionId, knowledgeChunks.versionId),
          ),
        )
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.organizationId, knowledgeChunks.organizationId),
            eq(documentVersions.id, knowledgeChunks.versionId),
            eq(documentVersions.documentId, knowledgeChunks.documentId),
          ),
        )
        .where(
          and(
            eq(knowledgeChunks.organizationId, this.organizationId),
            isNull(knowledgeChunks.deletedAt),
            isNull(knowledgeDocuments.deletedAt),
            isNull(documentVersions.deletedAt),
            eq(knowledgeDocuments.status, 'indexed'),
            eq(documentVersions.status, 'indexed'),
            eq(knowledgeChunks.embeddingModel, EMBEDDING_MODEL),
            sql`${knowledgeChunks.embedding} is not null`,
          ),
        );
      const result = await db.execute<{
        id: string;
        documentId: string;
        versionId: string;
        text: string;
        distance: number;
      }>(sql`
        WITH candidates AS MATERIALIZED (${candidates})
        SELECT id,document_id AS "documentId",version_id AS "versionId",text,
          embedding OPERATOR(public.<=>) ${JSON.stringify(vector)}::public.vector AS distance
        FROM candidates ORDER BY distance ASC,id ASC LIMIT ${first}`);
      return result.rows;
    });
  }

  async publish(documentId: string, versionId: string, actor: Actor) {
    this.assertActor(actor);
    return tenantDrizzle(this.pool, this.organizationId, async (db) => {
      const [document] = await db
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.organizationId, this.organizationId),
            eq(knowledgeDocuments.id, documentId),
            isNull(knowledgeDocuments.deletedAt),
          ),
        )
        .for('update');
      if (!document) throw new StoreConflict('not_found');
      const [version] = await db
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.organizationId, this.organizationId),
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.id, versionId),
            isNull(documentVersions.deletedAt),
          ),
        )
        .for('update');
      if (!version) throw new StoreConflict('not_found');
      if (document.activeVersionId === versionId && version.status === 'indexed') return;
      if (version.status !== 'processing') throw new StoreConflict('state');
      if (document.activeVersionId) {
        const [previous] = await db
          .select()
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.organizationId, this.organizationId),
              eq(documentVersions.id, document.activeVersionId),
            ),
          )
          .for('update');
        if (!previous || previous.revision >= version.revision) throw new StoreConflict('state');
      }
      const [counts] = await db
        .select({
          total: sql<number>`count(*)::int`,
          ready: sql<number>`count(*) filter (where embedding is not null and embedding_model=${EMBEDDING_MODEL})::int`,
        })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.organizationId, this.organizationId),
            eq(knowledgeChunks.versionId, versionId),
            isNull(knowledgeChunks.deletedAt),
          ),
        );
      if (!counts || counts.total === 0 || counts.total !== counts.ready)
        throw new StoreConflict('evidence');
      if (document.activeVersionId)
        await db
          .update(documentVersions)
          .set({ status: 'superseded' })
          .where(
            and(
              eq(documentVersions.organizationId, this.organizationId),
              eq(documentVersions.id, document.activeVersionId),
            ),
          );
      await db
        .update(documentVersions)
        .set({ status: 'indexed', indexedAt: new Date() })
        .where(
          and(
            eq(documentVersions.organizationId, this.organizationId),
            eq(documentVersions.id, versionId),
          ),
        );
      await db
        .update(knowledgeDocuments)
        .set({ activeVersionId: versionId, status: 'indexed' })
        .where(
          and(
            eq(knowledgeDocuments.organizationId, this.organizationId),
            eq(knowledgeDocuments.id, documentId),
          ),
        );
      await db.insert(auditEvents).values({
        id: randomUUID(),
        organizationId: this.organizationId,
        actorKind: actor.actorKind,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: 'document.published',
        resourceId: versionId,
      });
    });
  }

  async deleteVersion(documentId: string, versionId: string, actor: Actor) {
    this.assertActor(actor);
    return tenantDrizzle(this.pool, this.organizationId, async (db) => {
      const [document] = await db
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.organizationId, this.organizationId),
            eq(knowledgeDocuments.id, documentId),
            isNull(knowledgeDocuments.deletedAt),
          ),
        )
        .for('update');
      if (!document) throw new StoreConflict('not_found');
      const [version] = await db
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.organizationId, this.organizationId),
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.id, versionId),
          ),
        )
        .for('update');
      if (!version) throw new StoreConflict('not_found');
      if (version.deletedAt) return;
      if (document.activeVersionId === versionId)
        await db
          .update(knowledgeDocuments)
          .set({ activeVersionId: null, status: 'superseded' })
          .where(
            and(
              eq(knowledgeDocuments.organizationId, this.organizationId),
              eq(knowledgeDocuments.id, documentId),
            ),
          );
      await db
        .update(documentVersions)
        .set({ deletedAt: new Date(), status: 'superseded' })
        .where(
          and(
            eq(documentVersions.organizationId, this.organizationId),
            eq(documentVersions.id, versionId),
          ),
        );
      await db.insert(auditEvents).values({
        id: randomUUID(),
        organizationId: this.organizationId,
        actorKind: actor.actorKind,
        actorId: actor.actorId,
        requestId: actor.requestId,
        action: 'document.version_deleted',
        resourceId: versionId,
      });
    });
  }
  private assertActor(actor: Actor) {
    if (actor.organizationId !== this.organizationId) throw new StoreConflict('not_found');
  }
}
