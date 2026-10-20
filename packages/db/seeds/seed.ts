import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { schema } from '@resolvehub/db';
import { buildFixtures } from './fixtures.js';

export async function seedSynthetic(pool: pg.Pool) {
  const fixtures = buildFixtures();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('resolvehub:synthetic-seed:v1',0))",
    );
    const db = drizzle(client);
    const ids = fixtures.organizations.map((o) => o.id);
    const existing = await db
      .select()
      .from(schema.organizations)
      .where(inArray(schema.organizations.id, ids));
    if (
      existing.some(
        (row) =>
          !fixtures.organizations.some(
            (expected) => expected.id === row.id && expected.name === row.name,
          ),
      )
    )
      throw new Error('Fixture identity collision; refusing to replace organization');
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, ids));
    await db.insert(schema.organizations).values(fixtures.organizations);
    await db.insert(schema.memberships).values(fixtures.memberships);
    await db.insert(schema.customers).values(fixtures.customers);
    // Active pointers are deferred tenant-owned foreign keys.
    await db.insert(schema.knowledgeDocuments).values(fixtures.documents);
    await db.insert(schema.documentVersions).values(fixtures.versions);
    // Keep statements below PostgreSQL's bind-parameter limit.
    for (let start = 0; start < fixtures.chunks.length; start += 100)
      await db.insert(schema.knowledgeChunks).values(fixtures.chunks.slice(start, start + 100));
    await db.insert(schema.tickets).values(fixtures.tickets);
    await db.insert(schema.ticketMessages).values(fixtures.messages);
    await db.insert(schema.draftResponses).values(fixtures.drafts);
    await db.insert(schema.jobRuns).values(fixtures.jobs);
    await db.insert(schema.auditEvents).values(fixtures.audits);
    await db.insert(schema.idempotencyRecords).values(fixtures.receipts);
    // Insert triggers touch updated_at during compatibility customer upserts;
    // explicit fixture timestamps make the complete corpus byte-repeatable.
    await client.query('COMMIT');
    return {
      organizations: fixtures.organizations.length,
      documents: fixtures.documents.length,
      tickets: fixtures.tickets.length,
      versions: fixtures.versions.length,
      messages: fixtures.messages.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
