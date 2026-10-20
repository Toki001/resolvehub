import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDatabase, migrate } from '@resolvehub/db';

test('migrations install cleanly, preserve rows through expansion, repeat safely and reject changed history', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const admin = createDatabase(databaseUrl).pool;
  // Only this test-generated identifier is interpolated; no caller-controlled
  // schema/table names are accepted by the migration or API implementation.
  const schemaName = `rh_verify_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName}`);
  const scratch = createDatabase(url.toString()).pool;
  const directory = await mkdtemp(join(tmpdir(), 'resolvehub-migrations-'));
  const location = pathToFileURL(`${directory}/`);
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await copyFile(
      'packages/db/migrations/0001_contract_api.sql',
      join(directory, '0001_contract_api.sql'),
    );
    expect(await migrate(scratch, location)).toEqual(['0001_contract_api.sql']);
    expect(await migrate(scratch, location)).toEqual([]);
    await scratch.query(await readFile('packages/db/rollback/0001_initial.sql', 'utf8'));
    expect(await migrate(scratch, location)).toEqual(['0001_contract_api.sql']);
    const organizationId = randomUUID();
    const ticketId = randomUUID();
    await scratch.query("INSERT INTO organizations (id,name) VALUES ($1,'Migration fixture')", [
      organizationId,
    ]);
    await scratch.query(
      "INSERT INTO tickets (id,organization_id,subject,customer_email) VALUES ($1,$2,'Preserved ticket','fixture@example.test')",
      [ticketId, organizationId],
    );
    await copyFile(
      'packages/db/migrations/0002_replay_and_review_integrity.sql',
      join(directory, '0002_replay_and_review_integrity.sql'),
    );
    expect(await migrate(scratch, location)).toEqual(['0002_replay_and_review_integrity.sql']);
    expect(
      (
        await scratch.query('SELECT id FROM tickets WHERE organization_id=$1 AND id=$2', [
          organizationId,
          ticketId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(await migrate(scratch, location)).toEqual([]);
    const queuedDocument = randomUUID(),
      queuedVersion = randomUUID();
    await scratch.query(
      "INSERT INTO knowledge_documents(id,organization_id,title,status) VALUES($1,$2,'Pending ingestion','queued')",
      [queuedDocument, organizationId],
    );
    await scratch.query(
      "INSERT INTO document_versions(id,organization_id,document_id,object_key,media_type,size_bytes,sha256) VALUES($1,$2,$3,'synthetic-pending','text/plain',10,$4)",
      [queuedVersion, organizationId, queuedDocument, 'a'.repeat(64)],
    );
    for (const name of (await readdir('packages/db/migrations')).filter(
      (name) => name >= '0003' && name.endsWith('.sql'),
    )) {
      await copyFile(`packages/db/migrations/${name}`, join(directory, name));
    }
    expect(await migrate(scratch, location)).toEqual([
      '0003_persistence_expand.sql',
      '0004_persistence_validate.sql',
      '0005_citation_fixture_timestamps.sql',
      '0006_preserve_pending_ingestion.sql',
      '0007_ingestion_pipeline.sql',
    ]);
    expect(
      (
        await scratch.query(
          'SELECT c.email FROM tickets t JOIN customers c ON c.organization_id=t.organization_id AND c.id=t.customer_id WHERE t.id=$1',
          [ticketId],
        )
      ).rows[0],
    ).toEqual({ email: 'fixture@example.test' });
    expect(await migrate(scratch, location)).toEqual([]);
    expect(
      (
        await scratch.query(
          'SELECT status FROM document_versions WHERE organization_id=$1 AND id=$2',
          [organizationId, queuedVersion],
        )
      ).rows[0],
    ).toEqual({ status: 'queued' });
    const original = await readFile(join(directory, '0001_contract_api.sql'), 'utf8');
    await writeFile(
      join(directory, '0001_contract_api.sql'),
      `${original}\n-- Simulated corruption in an isolated test copy.\n`,
    );
    await expect(migrate(scratch, location)).rejects.toThrow('Applied migration was modified');
  } finally {
    await scratch.end();
    if (created) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
