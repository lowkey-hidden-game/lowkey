// test11.js - integration suite for the identity system, ISOLATED TEST DB ONLY.
// Requires env:
//   DATABASE_URL     - connection string of the TEST Neon project (never production)
//   GH_PAT           - repo token used for the GitHub WAL tests
//   CONFIRM_TEST_DB  - must equal '1', an explicit acknowledgment this runs on the test DB
// Covers: identity creation, recovery from another device, wrong-recovery lockout,
// device revocation + token invalidation, game independence from the DB, server restart,
// idempotency by UUID, player data isolation, and the 4 outbox failure cases.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makePool } = require('./db');
const { migrate } = require('./migrate');
const ID = require('./identity');
const { recordRound } = require('./recorder');
const { makeOutbox, WAL_BRANCH } = require('./outbox');

let pass = 0, fail = 0;
const failures = [];
const metrics = {};
function check(name, ok, extra) {
  ok ? pass++ : fail++;
  if (!ok) failures.push(name);
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  throw new Error('timeout: ' + label);
}
async function timeit(fn, n) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / n;
}

const GH_API = 'https://api.github.com';
const REPO = 'lowkey-hidden-game/lowkey';
const ghHeaders = tok => ({ Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'lowkey-test11' });

async function walList(tok) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/wal?ref=${WAL_BRANCH}`, { headers: ghHeaders(tok) });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('wal list: ' + r.status);
  return r.json();
}
async function walDelete(tok, file) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${file.path}`, { method: 'DELETE', headers: ghHeaders(tok), body: JSON.stringify({ message: 'test cleanup', sha: file.sha, branch: WAL_BRANCH }) });
  if (!r.ok) throw new Error('wal delete: ' + r.status);
}

function roundItem(uuid, playerId) {
  const t0 = new Date(Date.now() - 180000).toISOString();
  return {
    round_uuid: uuid, room_code: 'TEST', started_at: t0, ended_at: new Date().toISOString(),
    duration_s: 180, bot_level: 'normal', humans_count: 1, winner_id: playerId,
    end_reason: 'test', eligible: true, ineligible_reason: null,
    players: [{ player_id: playerId, result: 'win', powers_used: 2, deposits: 5, searches: 40 }],
  };
}
const countRound = (pool, uuid) => pool.query('SELECT count(*)::int c FROM rounds WHERE round_uuid=$1', [uuid]).then(r => r.rows[0].c);

(async () => {
  if (process.env.CONFIRM_TEST_DB !== '1') { console.error('refusing to run: CONFIRM_TEST_DB=1 required (test DB only)'); process.exit(2); }
  const CS = process.env.DATABASE_URL;
  const GH = process.env.GH_PAT;
  if (!CS || !GH) { console.error('refusing to run: DATABASE_URL and GH_PAT required'); process.exit(2); }
  const dbHost = (CS.match(/@([^/]+)/) || [])[1] || 'unknown';
  console.log('test database host: ' + dbHost);
  metrics.dbHost = dbHost;

  const pool = makePool(CS);

  // ---- 1. Migrations (identity + rounds only; achievements/cosmetics out of scope) ----
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lowkey-mig-'));
  for (const f of ['001_identity.sql', '002_rounds.sql']) fs.copyFileSync(path.join(__dirname, 'db', 'migrations', f), path.join(migDir, f));
  const m1 = await migrate(pool, migDir, () => {});
  const tabs = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.table_name);
  const needTabs = ['schema_migrations', 'players', 'player_devices', 'player_stats', 'player_loadout', 'rounds', 'round_players'];
  check('identity + rounds schema present after migrate', needTabs.every(t => tabs.includes(t)), 'applied=' + (m1.applied.join(',') || '(already present)'));
  const m2 = await migrate(pool, migDir, () => {});
  check('migrations idempotent (second run applies nothing)', m2.applied.length === 0 && !m2.skipped);

  // clean slate so reruns are repeatable
  await pool.query('TRUNCATE round_players, rounds, player_loadout, player_stats, player_devices, players');

  // ---- 2. Identity creation ----
  const A = await ID.createIdentity(pool, 'اختبار', 'iphone');
  check('identity created with LK player id', /^LK-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(A.playerId), A.playerId);
  const aRow = (await pool.query('SELECT recovery_hash, display_name FROM players WHERE player_id=$1', [A.playerId])).rows[0];
  check('recovery key stored only as scrypt hash', aRow && aRow.recovery_hash.startsWith('scrypt$') && !aRow.recovery_hash.includes(A.recoveryKey.replace(/-/g, '')));
  check('initial device verifies', (await ID.verifyDevice(pool, A.deviceId, A.deviceToken)) === A.playerId);
  check('wrong device token rejected', (await ID.verifyDevice(pool, A.deviceId, 'wrong-token')) === null);

  // ---- 3. Recovery from another device ----
  const rec = await ID.recover(pool, A.playerId, A.recoveryKey, 'chrome');
  check('recovery with correct key succeeds', rec.ok === true && rec.playerId === A.playerId);
  check('new device from recovery verifies', rec.ok && (await ID.verifyDevice(pool, rec.deviceId, rec.deviceToken)) === A.playerId);
  check('original device still valid after recovery (multi-device)', (await ID.verifyDevice(pool, A.deviceId, A.deviceToken)) === A.playerId);
  const devs = await ID.listDevices(pool, A.playerId);
  check('two devices listed for the player', devs.length === 2, 'devices=' + devs.length);

  // ---- 4. Wrong recovery attempts + lockout + anti-enumeration timing ----
  const wrongKey = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
  const ghostId = 'LK-ZZZZ-ZZZZ';
  let wrongRejected = 0, ghostRejected = 0;
  const tWrong = await timeit(async () => { const r = await ID.recover(pool, A.playerId, wrongKey); if (!r.ok && r.error === 'invalid_or_locked') wrongRejected++; }, 4);
  const tGhost = await timeit(async () => { const r = await ID.recover(pool, ghostId, wrongKey); if (!r.ok && r.error === 'invalid_or_locked') ghostRejected++; }, 4);
  metrics.msWrongKey = Math.round(tWrong); metrics.msGhost = Math.round(tGhost);
  check('wrong-key attempts rejected with generic error (real and unknown player alike)', wrongRejected === 4 && ghostRejected === 4);
  const aAfter4 = (await pool.query('SELECT rec_attempts, rec_locked_until FROM players WHERE player_id=$1', [A.playerId])).rows[0];
  check('failed attempts counted', aAfter4.rec_attempts === 4, 'attempts=' + aAfter4.rec_attempts);
  check('not locked before the 5th failure', aAfter4.rec_locked_until === null);
  const r5 = await ID.recover(pool, A.playerId, wrongKey);
  check('5th wrong attempt rejected', r5.ok === false && r5.error === 'invalid_or_locked');
  const aAfter5 = (await pool.query('SELECT rec_attempts, rec_locked_until FROM players WHERE player_id=$1', [A.playerId])).rows[0];
  const lock1s = (new Date(aAfter5.rec_locked_until) - Date.now()) / 1000;
  check('lock engages after 5 failures (~60s)', aAfter5.rec_attempts === 5 && lock1s > 40 && lock1s < 70, 'lock=' + Math.round(lock1s) + 's');
  const rLocked = await ID.recover(pool, A.playerId, A.recoveryKey);
  check('correct key still rejected while locked (generic error)', rLocked.ok === false && rLocked.error === 'invalid_or_locked');
  check('anti-enumeration: unknown player costs near-equal time', tGhost >= 0.4 * tWrong, 'ghost=' + Math.round(tGhost) + 'ms vs wrong=' + Math.round(tWrong) + 'ms');
  // escalation: simulate the lock expiring, fail once more -> next step (~5min)
  await pool.query("UPDATE players SET rec_locked_until = now() - interval '1 second' WHERE player_id=$1", [A.playerId]);
  await ID.recover(pool, A.playerId, wrongKey);
  const aAfter6 = (await pool.query('SELECT rec_attempts, rec_locked_until FROM players WHERE player_id=$1', [A.playerId])).rows[0];
  const lock2s = (new Date(aAfter6.rec_locked_until) - Date.now()) / 1000;
  check('lockout escalates (~5min after the 6th failure)', aAfter6.rec_attempts === 6 && lock2s > 240 && lock2s < 310, 'lock=' + Math.round(lock2s) + 's');
  await pool.query('UPDATE players SET rec_attempts=0, rec_locked_until=NULL WHERE player_id=$1', [A.playerId]);
  const rClean = await ID.recover(pool, A.playerId, A.recoveryKey, 'reset-check');
  check('recovery succeeds again after counters reset', rClean.ok === true);

  // ---- 5. Device revocation + token invalidation ----
  const devsBefore = await ID.listDevices(pool, A.playerId);
  const victim = devsBefore[devsBefore.length - 1];
  check('revoke own device succeeds', (await ID.revokeDevice(pool, A.playerId, victim.device_id)) === true);
  const victimTok = victim.device_id === rec.deviceId ? rec.deviceToken : (victim.device_id === rClean.deviceId ? rClean.deviceToken : null);
  if (victimTok) check('revoked token immediately invalid', (await ID.verifyDevice(pool, victim.device_id, victimTok)) === null);
  else check('revoked token immediately invalid', (await pool.query('SELECT revoked_at FROM player_devices WHERE device_id=$1', [victim.device_id])).rows[0].revoked_at !== null);
  check('double revoke is a no-op', (await ID.revokeDevice(pool, A.playerId, victim.device_id)) === false);

  // ---- 6. Player data isolation ----
  const B = await ID.createIdentity(pool, 'ضيف', 'android');
  check('cannot revoke another player\'s device', (await ID.revokeDevice(pool, B.playerId, A.deviceId)) === false);
  check('victim device survives cross-player revoke attempt', (await ID.verifyDevice(pool, A.deviceId, A.deviceToken)) === A.playerId);
  check('device/token pairs are not interchangeable across players', (await ID.verifyDevice(pool, A.deviceId, B.deviceToken)) === null);
  await pool.query("INSERT INTO player_stats (player_id, key, value) VALUES ($1,'wins',3),($2,'wins',7) ON CONFLICT DO NOTHING", [A.playerId, B.playerId]);
  const statA = (await pool.query("SELECT value::int v FROM player_stats WHERE player_id=$1 AND key='wins'", [A.playerId])).rows[0].v;
  const statB = (await pool.query("SELECT value::int v FROM player_stats WHERE player_id=$1 AND key='wins'", [B.playerId])).rows[0].v;
  check('per-player stats isolated by player_id', statA === 3 && statB === 7, 'A=' + statA + ' B=' + statB);

  // ---- 7. Idempotency by UUID ----
  const uuid1 = crypto.randomUUID();
  const item1 = roundItem(uuid1, A.playerId);
  check('first record of a round succeeds', (await recordRound(pool, item1)) === true);
  check('re-recording the same UUID is a no-op', (await recordRound(pool, item1)) === false);
  check('exactly one round row after duplicate attempts', (await countRound(pool, uuid1)) === 1);
  const rpCount = (await pool.query('SELECT count(*)::int c FROM round_players WHERE round_uuid=$1', [uuid1])).rows[0].c;
  check('round_players not duplicated', rpCount === item1.players.length, 'rows=' + rpCount);

  // ---- 8. Server restart: identity survives outside the process ----
  const pool2 = makePool(CS);
  check('device token verifies from a fresh connection (restart-safe)', (await ID.verifyDevice(pool2, A.deviceId, A.deviceToken)) === A.playerId);
  await pool2.end();

  // ---- 9. Game runs with the DB down ----
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  check('server.js has zero coupling to the identity/DB modules', !/require\(['"]\.\/(db|identity|outbox|recorder|migrate)['"]\)/.test(serverSrc));
  const gamePort = 8917;
  const gameLogFd = fs.openSync('/tmp/test11-game-server.log', 'w');
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(gamePort), DATABASE_URL: 'postgresql://127.0.0.1:1/lowkey_dead_db', ROUND_SECONDS: '15', FORCE_SPOT: '0' },
    stdio: ['ignore', gameLogFd, gameLogFd],
  });
  child.on('error', e => console.log('game server spawn error: ' + e.message));
  child.on('exit', c => console.log('game server exited early, code=' + c));
  try {
    const state = { id: null, room: '', began: false };
    let ws = null, wsDead = true; // undici keeps readyState=CONNECTING after a refused connect, so track failure explicitly
    await until(() => {
      if (wsDead) {
        wsDead = false;
        ws = new WebSocket('ws://localhost:' + gamePort);
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.t === 'joined') { state.id = m.id; state.room = m.room; }
          if (m.t === 'begin') state.began = true;
        };
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'اختبار', room: '' }));
        ws.onerror = () => { wsDead = true; };
        ws.onclose = () => { wsDead = true; };
      }
      return state.id;
    }, 10000, 'game server accepts join with dead DB');
    ws.send(JSON.stringify({ t: 'addbot' })); // 3-player minimum: 1 human + 2 bots
    await wait(400);
    ws.send(JSON.stringify({ t: 'addbot' }));
    await wait(400);
    ws.send(JSON.stringify({ t: 'start' }));
    await until(() => state.began, 5000, 'round begins with dead DB');
    check('full game flow (join, add bot, start round) with DB unreachable', state.began, 'room=' + state.room);
    ws.close();
  } finally {
    child.kill('SIGKILL');
  }

  // ---- Outbox failure cases ----
  // clean the WAL branch from any previous run
  for (const f of await walList(GH)) await walDelete(GH, f);

  // Case 1: crash after round end, before the WAL push -> round lost (documented window)
  const uuidC1 = crypto.randomUUID();
  const never = () => new Promise(() => {}); // GitHub push hangs; the "crash" happens first
  const ob1 = makeOutbox({ recordRound: async () => { throw new Error('neon down'); }, ghToken: GH, fetchImpl: never, log: () => {} });
  ob1.enqueue(roundItem(uuidC1, A.playerId));
  await wait(800); // the process "dies" here: instance abandoned mid-push
  const c1Db = await countRound(pool, uuidC1);
  const c1Wal = await walList(GH);
  check('case1: crash before WAL push leaves no durable copy (known window)', c1Db === 0 && !c1Wal.some(f => f.name === uuidC1 + '.json') && ob1.stats.walPushed === 0, 'db=' + c1Db + ' walPushed=' + ob1.stats.walPushed);
  metrics.case1 = 'round lost in the sub-second crash window, as designed/documented';

  // Case 2: WAL push succeeded, delete failed, boot reprocesses -> exactly one record
  const uuidC2 = crypto.randomUUID();
  const ob2 = makeOutbox({ recordRound: async () => { throw new Error('neon down'); }, ghToken: GH, log: () => {} });
  ob2.enqueue(roundItem(uuidC2, A.playerId));
  await until(() => ob2.stats.walPushed === 1, 20000, 'case2 wal push');
  // GitHub's contents listing is eventually consistent right after a write; poll for the file
  const c2File = await until(async () => (await walList(GH)).find(f => f.name === uuidC2 + '.json') || false, 10000, 'case2 wal visible');
  check('case2: round durably in GitHub WAL while Neon is down', !!c2File);
  const ob2b = makeOutbox({ recordRound: it => recordRound(pool, it), ghToken: GH, log: () => {} }); // "rebooted" server, Neon back
  const replayed1 = await ob2b.recover({ skipDeleteSha: c2File.sha }); // delete "fails" for this file
  const c2AfterFirst = await countRound(pool, uuidC2);
  const walAfterFirst = await walList(GH);
  check('case2: boot replay records the round even though the WAL delete failed', replayed1 === 1 && c2AfterFirst === 1 && walAfterFirst.some(f => f.name === uuidC2 + '.json'));
  const replayed2 = await ob2b.recover(); // next boot reprocesses the leftover file
  const c2Final = await countRound(pool, uuidC2);
  check('case2: reprocessing the leftover WAL file causes no duplicate', replayed2 === 1 && c2Final === 1, 'replayed=' + replayed2 + ' rows=' + c2Final);
  // GitHub's contents listing is eventually consistent right after a delete; poll briefly
  const walGone = await until(async () => !(await walList(GH)).some(f => f.name === uuidC2 + '.json'), 8000, 'case2 wal cleanup').catch(() => false);
  check('case2: WAL file cleaned up after successful ack', walGone === true);

  // Case 2b: corrupted / mismatched WAL files are never replayed and never deleted (left for inspection)
  const badUuid = crypto.randomUUID();
  const putWal = async (name, contentB64) => {
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/wal/${name}`, { method: 'PUT', headers: ghHeaders(GH), body: JSON.stringify({ message: 'test corrupt wal', content: contentB64, branch: WAL_BRANCH }) });
    if (!r.ok) throw new Error('seed corrupt wal: ' + r.status);
  };
  await putWal(badUuid + '.json', Buffer.from('this is not json{{{').toString('base64')); // unparseable
  const mismatchUuid = crypto.randomUUID();
  await putWal(mismatchUuid + '.json', Buffer.from(JSON.stringify(roundItem(crypto.randomUUID(), A.playerId))).toString('base64')); // payload UUID != filename
  await until(async () => (await walList(GH)).some(f => f.name === badUuid + '.json'), 10000, 'corrupt wal visible');
  const ob2c = makeOutbox({ recordRound: it => recordRound(pool, it), ghToken: GH, log: () => {} });
  const replayedBad = await ob2c.recover();
  const walAfterBad = await walList(GH);
  check('case2b: corrupted WAL files skipped, never replayed', replayedBad === 0 && ob2c.stats.corrupted === 2, 'corrupted=' + ob2c.stats.corrupted);
  check('case2b: corrupted WAL files left in place for inspection', walAfterBad.some(f => f.name === badUuid + '.json') && walAfterBad.some(f => f.name === mismatchUuid + '.json'));
  check('case2b: corrupted content never reached the database', (await countRound(pool, badUuid)) === 0 && (await countRound(pool, mismatchUuid)) === 0);
  for (const f of walAfterBad) await walDelete(GH, f); // manual cleanup of inspection files

  // Case 3: expired GitHub token / GitHub unreachable -> CRITICAL counted, L1 keeps retrying
  const uuidC3 = crypto.randomUUID();
  let dbDown = true;
  const ob3 = makeOutbox({ recordRound: async it => { if (dbDown) throw new Error('neon down'); return recordRound(pool, it); }, ghToken: 'invalid-expired-token', log: () => {} });
  ob3.enqueue(roundItem(uuidC3, A.playerId));
  await until(() => ob3.stats.critical >= 1, 15000, 'case3 critical');
  check('case3: bad/expired GitHub token during Neon outage raises CRITICAL, item kept in L1', ob3.stats.critical >= 1 && ob3.stats.depth === 1 && ob3.stats.delivered === 0, 'critical=' + ob3.stats.critical);
  dbDown = false; // Neon recovers; the in-memory queue alone completes delivery
  await until(() => ob3.stats.delivered === 1, 20000, 'case3 L1 redelivery');
  check('case3: L1 queue delivers once Neon is back (no WAL needed)', (await countRound(pool, uuidC3)) === 1);
  const uuidC3b = crypto.randomUUID();
  const ob3b = makeOutbox({ recordRound: async () => { throw new Error('neon down'); }, ghToken: GH, fetchImpl: async () => { throw new Error('network unreachable'); }, log: () => {} });
  ob3b.enqueue(roundItem(uuidC3b, A.playerId));
  await until(() => ob3b.stats.critical >= 1, 15000, 'case3b critical');
  check('case3: GitHub unreachable (network) raises CRITICAL the same way', ob3b.stats.critical >= 1 && ob3b.stats.depth === 1);

  // Case 4: no double-record via UUID across every path
  const replayed3 = await ob2b.recover(); // WAL is empty now
  check('case4: recovery on an empty WAL replays nothing', replayed3 === 0);
  check('case4: case2 round still exactly one row after all replays', (await countRound(pool, uuidC2)) === 1);
  check('case4: every recorded round UUID unique in the table', (await pool.query('SELECT count(*)::int a, count(DISTINCT round_uuid)::int b FROM rounds')).rows[0].a === (await pool.query('SELECT count(*)::int a, count(DISTINCT round_uuid)::int b FROM rounds')).rows[0].b);

  metrics.roundsInTestDb = (await pool.query('SELECT count(*)::int c FROM rounds')).rows[0].c;
  metrics.playersInTestDb = (await pool.query('SELECT count(*)::int c FROM players')).rows[0].c;

  fs.rmSync(migDir, { recursive: true, force: true });
  await pool.end();
  console.log('---');
  console.log('metrics: ' + JSON.stringify(metrics));
  console.log(fail ? 'FAILURES: ' + fail + ' -> ' + failures.join('; ') : 'ALL ' + pass + ' INTEGRATION TESTS PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR: ' + e.message); process.exit(1); });
