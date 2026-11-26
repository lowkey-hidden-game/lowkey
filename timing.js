// timing.js - step 4: large-sample, server-side-only timing of recover() for existing vs nonexistent player.
// The locked-player path (SELECT + scrypt + return) is DB-identical to the nonexistent path, so any
// remaining difference is network noise; we subtract a measured SELECT-1 RTT to isolate server time.
// Requires env: DATABASE_URL (test project), CONFIRM_TEST_DB=1.
const { makePool } = require('./db');
const ID = require('./identity');
const C = require('./crypto_utils');

function stats(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), min: +a[0].toFixed(2), max: +a[a.length - 1].toFixed(2) };
}

(async () => {
  if (process.env.CONFIRM_TEST_DB !== '1') { console.error('refusing: CONFIRM_TEST_DB=1 required'); process.exit(2); }
  const pool = makePool(process.env.DATABASE_URL);
  const N = 150;
  const wrongKey = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
  const ghostId = 'LK-ZZZZ-ZZZZ';

  const P = await ID.createIdentity(pool, 'توقيت', 'timing');
  // lock the account: the recover path becomes SELECT + scrypt + return (identical DB shape to ghost)
  await pool.query("UPDATE players SET rec_locked_until = now() + interval '1 hour' WHERE player_id=$1", [P.playerId]);

  // warm-up
  for (let i = 0; i < 5; i++) { await ID.recover(pool, P.playerId, wrongKey); await ID.recover(pool, ghostId, wrongKey); }

  const tLocked = [], tGhost = [], tRtt = [];
  for (let i = 0; i < N; i++) {
    let t0 = process.hrtime.bigint();
    await ID.recover(pool, P.playerId, wrongKey);
    tLocked.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint();
    await ID.recover(pool, ghostId, wrongKey);
    tGhost.push(Number(process.hrtime.bigint() - t0) / 1e6);
    t0 = process.hrtime.bigint();
    await pool.query('SELECT 1');
    tRtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  // pure compute: scrypt verify alone, no DB
  const h = C.hashRecoveryKey(wrongKey);
  const tScrypt = [];
  for (let i = 0; i < 50; i++) { const t0 = process.hrtime.bigint(); C.verifyRecoveryKey(wrongKey, h); tScrypt.push(Number(process.hrtime.bigint() - t0) / 1e6); }

  const sL = stats(tLocked), sG = stats(tGhost), sR = stats(tRtt), sS = stats(tScrypt);
  const serverLocked = +(sL.median - sR.median).toFixed(2);
  const serverGhost = +(sG.median - sR.median).toFixed(2);
  console.log('locked existing player (total ms):  ' + JSON.stringify(sL));
  console.log('nonexistent player  (total ms):  ' + JSON.stringify(sG));
  console.log('SELECT 1 RTT baseline (ms):      ' + JSON.stringify(sR));
  console.log('pure scrypt verify (ms):         ' + JSON.stringify(sS));
  console.log('server-only estimate (median total - median RTT): locked=' + serverLocked + 'ms ghost=' + serverGhost + 'ms diff=' + +(serverLocked - serverGhost).toFixed(2) + 'ms');
  await pool.query("UPDATE players SET rec_locked_until = NULL WHERE player_id=$1", [P.playerId]);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
