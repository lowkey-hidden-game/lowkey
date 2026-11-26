// test12.js - backup & restore suite on isolated test projects ONLY. Implements Ibrahim's 7 steps.
// Requires env: DATABASE_URL (test project), RESTORE_DATABASE_URL (separate restore project),
// GH_PAT (repo token), BACKUP_KEY (test passphrase), CONFIRM_TEST_DB=1.
const crypto = require('crypto');
const { makePool } = require('./db');
const { migrate } = require('./migrate');
const ID = require('./identity');
const { recordRound } = require('./recorder');
const { makeBackupStore, encryptBackup, decryptBackup, exportData, TABLES, KEEP } = require('./backup');
const { restore } = require('./restore');
const fs = require('fs'); const os = require('os'); const path = require('path');

let pass = 0, fail = 0; const failures = [];
function check(name, ok, extra) { ok ? pass++ : fail++; if (!ok) failures.push(name); console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

// order-independent canonical hash of a table's rows
function tableHash(rows) {
  const canon = rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k] === null ? null : String(r[k])]))).sort();
  return crypto.createHash('sha256').update(canon.join('\n')).digest('hex');
}

(async () => {
  if (process.env.CONFIRM_TEST_DB !== '1') { console.error('refusing: CONFIRM_TEST_DB=1 required'); process.exit(2); }
  const CS = process.env.DATABASE_URL, RCS = process.env.RESTORE_DATABASE_URL, GH = process.env.GH_PAT, KEY = process.env.BACKUP_KEY;
  if (!CS || !RCS || !GH || !KEY) { console.error('refusing: DATABASE_URL, RESTORE_DATABASE_URL, GH_PAT, BACKUP_KEY required'); process.exit(2); }
  if (CS === RCS) { console.error('refusing: restore target must be a DIFFERENT database'); process.exit(2); }
  const metrics = {};
  const pool = makePool(CS);
  const rpool = makePool(RCS);
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lowkey-mig-'));
  for (const f of ['001_identity.sql', '002_rounds.sql']) fs.copyFileSync(path.join(__dirname, 'db', 'migrations', f), path.join(migDir, f));
  await migrate(pool, migDir, () => {});
  await migrate(rpool, migDir, () => {});
  await pool.query('TRUNCATE round_players, rounds, player_loadout, player_stats, player_devices, players');

  // Step 1: create test data
  const P1 = await ID.createIdentity(pool, 'نسخة١', 'iphone');
  const P2 = await ID.createIdentity(pool, 'نسخة٢', 'android');
  const rec = await ID.recover(pool, P1.playerId, P1.recoveryKey, 'chrome');
  await pool.query("INSERT INTO player_stats (player_id, key, value) VALUES ($1,'wins',5),($1,'matches_played',9),($2,'wins',2)", [P1.playerId, P2.playerId]);
  await pool.query('INSERT INTO player_loadout (player_id, avatar_cosmetic_id) VALUES ($1, $2)', [P1.playerId, 'av_test']);
  const rd = roundItemLocal(P1.playerId);
  await recordRound(pool, rd);
  check('step1: test data seeded', true, '2 players, 3 devices, 3 stats, 1 loadout, 1 round');

  // Step 2: full backup (timed)
  const store = makeBackupStore({ ghToken: GH });
  const t0 = Date.now();
  const res = await store.run(pool, KEY);
  metrics.backupMs = res.ms; metrics.backupBytes = res.bytes;
  check('step2: encrypted backup pushed to GitHub', !!res.name && res.ms > 0, res.name + ' ' + res.bytes + 'B in ' + res.ms + 'ms');

  // Step 3: restore onto the separate Neon project (timed)
  const files = await store.list();
  const file = files.find(f => f.name === res.name);
  const blob = await store.fetchBlob(file);
  const payload = decryptBackup(blob, KEY);
  const t1 = Date.now();
  const inserted = await restore(rpool, payload);
  metrics.restoreMs = Date.now() - t1;
  check('step3: restore onto separate project completed', inserted.players === 2 && inserted.rounds === 1, JSON.stringify(inserted) + ' in ' + metrics.restoreMs + 'ms');

  // Step 4: compare data and relations (counts + order-independent content hashes + FK joins)
  let same = true;
  for (const t of TABLES) {
    const a = (await pool.query(`SELECT * FROM ${t}`)).rows;
    const b = (await rpool.query(`SELECT * FROM ${t}`)).rows;
    if (a.length !== b.length || tableHash(a) !== tableHash(b)) { same = false; console.log('  mismatch in ' + t + ': src=' + a.length + ' dst=' + b.length); }
  }
  check('step4: all 6 tables identical (count + content hash)', same);
  const fk1 = (await rpool.query('SELECT count(*)::int c FROM player_devices d JOIN players p ON p.player_id=d.player_id')).rows[0].c;
  const fk2 = (await rpool.query('SELECT count(*)::int c FROM round_players rp JOIN rounds r ON r.round_uuid=rp.round_uuid')).rows[0].c;
  check('step4: relations intact after restore', fk1 === 3 && fk2 === 1, 'devices=' + fk1 + ' round_players=' + fk2);

  // Step 5: identity tests after restore (recover with original key, verify original device token, revoke)
  check('step5: original device token verifies on restored DB', (await ID.verifyDevice(rpool, P1.deviceId, P1.deviceToken)) === P1.playerId);
  const rec2 = await ID.recover(rpool, P1.playerId, P1.recoveryKey, 'post-restore');
  check('step5: recovery with original key works on restored DB', rec2.ok === true);
  check('step5: revocation works on restored DB', (await ID.revokeDevice(rpool, P1.playerId, rec.deviceId)) === true && (await ID.verifyDevice(rpool, rec.deviceId, rec.deviceToken)) === null);

  // Step 6: corrupted / incomplete backups must be refused
  let refused = 0, total = 5;
  try { decryptBackup(blob, 'wrong-passphrase'); } catch (e) { refused++; }
  try { decryptBackup(blob.slice(0, blob.length - 40), KEY); } catch (e) { refused++; }
  try { const raw = Buffer.from(blob, 'base64'); raw[50] ^= 0xff; decryptBackup(raw.toString('base64'), KEY); } catch (e) { refused++; }
  try { const bad = JSON.parse(JSON.stringify(payload)); delete bad.tables.rounds; await restore(rpool, bad); } catch (e) { refused++; }
  try { const bad = JSON.parse(JSON.stringify(payload)); bad.tables.player_devices[0].player_id = 'LK-GHOS-T000'; await restore(rpool, bad); } catch (e) { refused++; }
  check('step6: all 5 corruption cases refused (wrong key, truncated, tampered, missing table, broken FK)', refused === total, refused + '/' + total);
  const survivors = (await rpool.query('SELECT count(*)::int c FROM players')).rows[0].c;
  check('step6: failed restores left the restored data untouched', survivors === 2, 'players=' + survivors);

  // Retention: push until over KEEP, expect exactly KEEP kept
  for (let i = 0; i < KEEP + 1; i++) await store.run(pool, KEY);
  const kept = await store.list();
  check('retention: keeps exactly the newest ' + KEEP + ' backups', kept.length === KEEP, 'kept=' + kept.length);
  check('retention: oldest backups pruned first (seeded one is beyond the window after 10 pushes)', !kept.some(f => f.name === res.name));

  metrics.kept = kept.length;
  fs.rmSync(migDir, { recursive: true, force: true });
  await pool.end(); await rpool.end();
  console.log('---'); console.log('metrics: ' + JSON.stringify(metrics));
  console.log(fail ? 'FAILURES: ' + fail + ' -> ' + failures.join('; ') : 'ALL ' + pass + ' BACKUP/RESTORE TESTS PASSED');
  process.exit(fail ? 1 : 0);

  function roundItemLocal(playerId) {
    return { round_uuid: crypto.randomUUID(), room_code: 'BKUP', started_at: new Date(Date.now() - 180000).toISOString(), ended_at: new Date().toISOString(), duration_s: 180, bot_level: 'normal', humans_count: 1, winner_id: playerId, end_reason: 'backup-test', eligible: true, ineligible_reason: null, players: [{ player_id: playerId, result: 'win', powers_used: 1, deposits: 3, searches: 20 }] };
  }
})().catch(e => { console.error('SUITE ERROR: ' + e.message); process.exit(1); });
