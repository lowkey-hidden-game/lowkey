// outbox.js - durable round-result delivery. Two layers:
//   L1: in-memory queue with backoff (covers short Neon blips)
//   L2: GitHub WAL branch (wal-rounds) - one JSON file per round UUID, pushed when Neon is down
// Boot recovery replays the WAL branch idempotently (UUID primary key) then deletes files.
// The game never waits on this: enqueue() returns immediately.
const REPO = 'lowkey-hidden-game/lowkey';
const WAL_BRANCH = 'wal-rounds';
const API = 'https://api.github.com';

// A WAL file is trusted only if it parses, has the required fields with the right types,
// and its payload UUID matches the filename. Anything else is left in place for inspection.
function validWalItem(item, expectedUuid) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.round_uuid !== 'string' || !item.round_uuid || item.round_uuid !== expectedUuid) return false;
  if (typeof item.room_code !== 'string' || typeof item.end_reason !== 'string') return false;
  if (!item.started_at || !item.ended_at || isNaN(Date.parse(item.started_at)) || isNaN(Date.parse(item.ended_at))) return false;
  if (typeof item.duration_s !== 'number' || !Number.isFinite(item.duration_s)) return false;
  if (typeof item.humans_count !== 'number' || !Number.isFinite(item.humans_count)) return false;
  if (item.players !== undefined) {
    if (!Array.isArray(item.players)) return false;
    for (const p of item.players) if (!p || typeof p.player_id !== 'string' || typeof p.result !== 'string') return false;
  }
  return true;
}

function makeOutbox({ recordRound, ghToken, log = console.log, fetchImpl = fetch, maxBackoffMs = 60000 }) {
  const queue = [];
  const stats = { depth: 0, walPending: 0, delivered: 0, walPushed: 0, critical: 0, corrupted: 0, ghAuthError: false };
  let working = false;
  let backoff = 1000;

  const headers = () => ({ Authorization: 'Bearer ' + ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'lowkey-outbox' });

  async function ensureBranch() {
    const r = await fetchImpl(`${API}/repos/${REPO}/git/ref/heads/main`, { headers: headers() });
    if (!r.ok) throw new Error('gh main ref: ' + r.status);
    const sha = (await r.json()).object.sha;
    const c = await fetchImpl(`${API}/repos/${REPO}/git/refs`, { method: 'POST', headers: headers(), body: JSON.stringify({ ref: 'refs/heads/' + WAL_BRANCH, sha }) });
    if (!c.ok && c.status !== 422) throw new Error('gh branch: ' + c.status); // 422 = exists
  }

  function noteAuth(r) { if (r.status === 401 || r.status === 403) stats.ghAuthError = true; }

  async function walPush(item) {
    await ensureBranch();
    const body = { message: 'wal: round ' + item.round_uuid, content: Buffer.from(JSON.stringify(item)).toString('base64'), branch: WAL_BRANCH };
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/wal/${item.round_uuid}.json`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) { noteAuth(r); throw new Error('gh wal push: ' + r.status); }
    stats.walPushed++; stats.walPending++;
  }

  async function walList() {
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/wal?ref=${WAL_BRANCH}`, { headers: headers() });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('gh wal list: ' + r.status);
    return r.json();
  }

  async function walDelete(file) {
    const r = await fetchImpl(`${API}/repos/${REPO}/contents/${file.path}`, { method: 'DELETE', headers: headers(), body: JSON.stringify({ message: 'wal: acked ' + file.name, sha: file.sha, branch: WAL_BRANCH }) });
    if (!r.ok) throw new Error('gh wal delete: ' + r.status);
  }

  // Replay WAL branch into Neon. Idempotent; a delete failure just means we reprocess next boot.
  // Corrupted or malformed files are never replayed and never deleted: they stay for inspection.
  async function recover({ skipDeleteSha } = {}) {
    const files = await walList();
    let replayed = 0;
    for (const f of files) {
      const raw = await fetchImpl(f.download_url, { headers: headers() });
      if (!raw.ok) throw new Error('gh wal fetch: ' + raw.status);
      let item = null;
      const expectedUuid = (f.name || '').replace(/\.json$/, '');
      try { item = await raw.json(); } catch (e) { item = null; }
      if (!validWalItem(item, expectedUuid)) {
        stats.corrupted++;
        log('WAL: skipping corrupted/invalid file ' + f.name + ' (left in place for inspection)');
        continue;
      }
      await recordRound(item); // ON CONFLICT DO NOTHING - safe to reprocess
      replayed++;
      if (!(skipDeleteSha && f.sha === skipDeleteSha)) await walDelete(f);
    }
    stats.walPending = Math.max(0, stats.walPending - replayed);
    return replayed;
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const item = queue[0];
        try {
          await recordRound(item);
          queue.shift();
          stats.delivered++;
          backoff = 1000;
        } catch (dbErr) {
          if (!item.wal) {
            try { await walPush(item); item.wal = true; }
            catch (walErr) { stats.critical++; log('CRITICAL: DB and WAL both failed for round ' + item.round_uuid + ': ' + walErr.message); }
          }
          stats.depth = queue.length;
          await new Promise(r => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, maxBackoffMs);
        }
      }
    } finally {
      working = false;
      stats.depth = queue.length;
    }
  }

  function enqueue(roundResult) {
    queue.push(roundResult);
    stats.depth = queue.length;
    setImmediate(work);
  }

  return { enqueue, recover, stats, _queue: queue, _work: work };
}

module.exports = { makeOutbox, WAL_BRANCH };
