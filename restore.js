// restore.js - validate a decrypted backup payload and restore it into a target database.
// Refuses on ANY inconsistency: wrong format, missing tables, or broken relations.
// The restore is one transaction: either the whole snapshot lands or nothing does.
const { TABLES } = require('./backup');

const INSERT_ORDER = ['players', 'player_devices', 'player_stats', 'player_loadout', 'rounds', 'round_players'];

// Columns per table, matching db/migrations/001_identity.sql + 002_rounds.sql.
const COLUMNS = {
  players: ['player_id', 'display_name', 'avatar_id', 'title_id', 'xp', 'recovery_hash', 'rec_attempts', 'rec_locked_until', 'created_at', 'last_seen_at'],
  player_devices: ['device_id', 'player_id', 'token_hash', 'label', 'created_at', 'last_used_at', 'revoked_at'],
  player_stats: ['player_id', 'key', 'value'],
  player_loadout: ['player_id', 'avatar_cosmetic_id', 'title_cosmetic_id', 'effect_cosmetic_id', 'entrance_cosmetic_id', 'win_anim_cosmetic_id', 'updated_at'],
  rounds: ['round_uuid', 'room_code', 'started_at', 'ended_at', 'duration_s', 'bot_level', 'humans_count', 'winner_id', 'end_reason', 'eligible', 'ineligible_reason', 'recorded_at'],
  round_players: ['round_uuid', 'player_id', 'result', 'powers_used', 'deposits', 'searches'],
};

function validatePayload(p) {
  if (!p || p.format !== 'lowkey-backup' || p.version !== 1) throw new Error('not a lowkey-backup v1 payload');
  if (!p.tables || typeof p.tables !== 'object') throw new Error('payload has no tables');
  for (const t of TABLES) if (!Array.isArray(p.tables[t])) throw new Error('missing or invalid table: ' + t);
  // relation integrity inside the snapshot itself
  const players = new Set(p.tables.players.map(r => r.player_id));
  const rounds = new Set(p.tables.rounds.map(r => r.round_uuid));
  for (const r of p.tables.player_devices) if (!players.has(r.player_id)) throw new Error('player_devices references unknown player ' + r.player_id);
  for (const r of p.tables.player_stats) if (!players.has(r.player_id)) throw new Error('player_stats references unknown player ' + r.player_id);
  for (const r of p.tables.player_loadout) if (!players.has(r.player_id)) throw new Error('player_loadout references unknown player ' + r.player_id);
  for (const r of p.tables.round_players) if (!rounds.has(r.round_uuid)) throw new Error('round_players references unknown round ' + r.round_uuid);
  return true;
}

async function restore(pool, payload) {
  validatePayload(payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE round_players, rounds, player_loadout, player_stats, player_devices, players');
    const inserted = {};
    for (const t of INSERT_ORDER) {
      const cols = COLUMNS[t];
      let n = 0;
      for (const row of payload.tables[t]) {
        const vals = cols.map(c => row[c] === undefined ? null : row[c]);
        await client.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
        n++;
      }
      inserted[t] = n;
    }
    await client.query('COMMIT');
    return inserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { restore, validatePayload, COLUMNS };
