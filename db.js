// db.js - Postgres pool for the identity service. Decoupled: game never imports this.
const { Pool } = require('pg');

function makePool(connectionString) {
  // pg does not support channel_binding=require; strip it (TLS still required via sslmode)
  const cs = String(connectionString).replace(/[&?]channel_binding=require/, '');
  return new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false }, max: 5 });
}

async function withRetry(fn, tries = 3, delayMs = 500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, delayMs * (i + 1))); }
  }
  throw last;
}

module.exports = { makePool, withRetry };
