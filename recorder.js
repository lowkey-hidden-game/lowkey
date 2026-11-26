// recorder.js - idempotent round recording. UUID is the natural key.
async function recordRound(pool, item) {
  // item: { round_uuid, room_code, started_at, ended_at, duration_s, bot_level, humans_count, winner_id, end_reason, eligible, ineligible_reason, players: [{player_id, result, powers_used, deposits, searches}] }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO rounds (round_uuid, room_code, started_at, ended_at, duration_s, bot_level, humans_count, winner_id, end_reason, eligible, ineligible_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (round_uuid) DO NOTHING`,
      [item.round_uuid, item.room_code, item.started_at, item.ended_at, item.duration_s, item.bot_level || 'normal', item.humans_count, item.winner_id || null, item.end_reason, !!item.eligible, item.ineligible_reason || null]);
    if (r.rowCount === 1) {
      for (const p of item.players || []) {
        await client.query(
          `INSERT INTO round_players (round_uuid, player_id, result, powers_used, deposits, searches) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [item.round_uuid, p.player_id, p.result, p.powers_used || 0, p.deposits || 0, p.searches || 0]);
      }
    }
    await client.query('COMMIT');
    return r.rowCount === 1; // true = newly recorded, false = already existed
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { recordRound };
