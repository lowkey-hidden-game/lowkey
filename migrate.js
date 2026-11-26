// migrate.js - ordered, locked, idempotent migrations. Never throws away game uptime:
// caller decides what failure means (identity disabled, game keeps running).
const fs = require('fs');
const path = require('path');

const LOCK_KEY = 814506; // advisory lock key for lowkey migrations

async function migrate(pool, dir = path.join(__dirname, 'db', 'migrations'), log = console.log) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    if (!rows[0].got) { log('migration lock held by another runner; skipping'); return { applied: [], skipped: true }; }
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
      const applied = [];
      for (const f of files) {
        const version = f.replace(/\.sql$/, '');
        if (done.has(version)) continue;
        const sql = fs.readFileSync(path.join(dir, f), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
          await client.query('COMMIT');
          applied.push(version);
          log('applied migration ' + version);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error('migration ' + version + ' failed: ' + e.message);
        }
      }
      return { applied, skipped: false };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

module.exports = { migrate, LOCK_KEY };
