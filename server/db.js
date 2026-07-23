import { createClient } from '@libsql/client';

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars);
// a local libSQL file otherwise — same client, same SQL.
const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

export const db = createClient(authToken ? { url, authToken } : { url });

export async function initDb() {
  // Phase 0: a single trivial table proving DB round-trips work in production.
  // Real schema (characters, dice, ...) lands in Phase 1.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY,
      client_label TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
