import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { stageSnapshot } from './stage.mjs';
import { fixture } from '../test/fixture.mjs';

const db = new PGlite(); // Memory only; no server, persistent DB, or real credentials.
try {
  await db.exec(readFileSync(new URL('../migrations/001_import_staging.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/002_source_trip_ids.sql', import.meta.url), 'utf8'));
  const input = fixture();
  await db.query('INSERT INTO import_staging.tenants(id,name) VALUES ($1,$2)', [input.tenantId, 'ВЫМЫШЛЕННАЯ КОМПАНИЯ']);
  const first = await stageSnapshot(db, input);
  const second = await stageSnapshot(db, input);
  const stored = await db.query('SELECT count(*)::int AS count FROM import_staging.source_rows');
  console.log(JSON.stringify({ demoOnly: true, database: 'in-memory PostgreSQL/PGlite',
    first, repeatedImportReused: second.reused, storedSourceRows: stored.rows[0].count }, null, 2));
} finally { await db.close(); }
