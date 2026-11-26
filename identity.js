// identity.js - identity service API. Pure functions over a pg pool; the game never imports this.
const crypto = require('crypto');
const C = require('./crypto_utils');

// Dummy hash so recovery attempts on non-existent players cost the same as real ones.
const DUMMY_HASH = C.hashRecoveryKey('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
const LOCK_STEPS_MS = [60e3, 5 * 60e3, 60 * 60e3]; // after 5 fails: 1m, then 5m, then 1h
const MAX_FAILS = 5;

async function createIdentity(pool, displayName, label) {
  const playerId = C.genPlayerId();
  const recoveryKey = C.genRecoveryKey();
  const recoveryHash = C.hashRecoveryKey(recoveryKey);
  const deviceId = crypto.randomUUID();
  const deviceToken = C.genDeviceToken();
  await pool.query('INSERT INTO players (player_id, display_name, recovery_hash) VALUES ($1, $2, $3)', [playerId, displayName || '', recoveryHash]);
  await pool.query('INSERT INTO player_devices (device_id, player_id, token_hash, label) VALUES ($1, $2, $3, $4)', [deviceId, playerId, C.hashDeviceToken(deviceToken), label || '']);
  // recoveryKey and deviceToken are shown to the player ONCE. Never stored.
  return { playerId, recoveryKey, deviceId, deviceToken };
}

// Same response shape and near-same cost whether the player exists or not.
async function recover(pool, playerId, recoveryKey, label) {
  const { rows } = await pool.query('SELECT player_id, recovery_hash, rec_attempts, rec_locked_until FROM players WHERE player_id = $1', [playerId]);
  const p = rows[0];
  const hashToCheck = p ? p.recovery_hash : DUMMY_HASH;
  const ok = C.verifyRecoveryKey(recoveryKey, hashToCheck);
  if (p && p.rec_locked_until && new Date(p.rec_locked_until) > new Date()) {
    return { ok: false, error: 'invalid_or_locked' }; // generic on purpose
  }
  if (!p || !ok) {
    if (p) {
      const fails = p.rec_attempts + 1;
      const lockMs = fails >= MAX_FAILS ? LOCK_STEPS_MS[Math.min(fails - MAX_FAILS, LOCK_STEPS_MS.length - 1)] : null;
      await pool.query('UPDATE players SET rec_attempts = $1, rec_locked_until = $2 WHERE player_id = $3',
        [fails, lockMs ? new Date(Date.now() + lockMs) : null, playerId]);
    }
    return { ok: false, error: 'invalid_or_locked' };
  }
  await pool.query('UPDATE players SET rec_attempts = 0, rec_locked_until = NULL, last_seen_at = now() WHERE player_id = $1', [playerId]);
  const deviceId = crypto.randomUUID();
  const deviceToken = C.genDeviceToken();
  await pool.query('INSERT INTO player_devices (device_id, player_id, token_hash, label) VALUES ($1, $2, $3, $4)', [deviceId, playerId, C.hashDeviceToken(deviceToken), label || '']);
  return { ok: true, playerId, deviceId, deviceToken };
}

// Verify a device token; returns player_id or null. Revoked tokens are rejected.
async function verifyDevice(pool, deviceId, deviceToken) {
  const { rows } = await pool.query('SELECT player_id, token_hash FROM player_devices WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
  const d = rows[0];
  if (!d) return null;
  const a = Buffer.from(C.hashDeviceToken(deviceToken));
  const b = Buffer.from(d.token_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  await pool.query('UPDATE player_devices SET last_used_at = now() WHERE device_id = $1', [deviceId]);
  return d.player_id;
}

async function listDevices(pool, playerId) {
  const { rows } = await pool.query('SELECT device_id, label, created_at, last_used_at, revoked_at FROM player_devices WHERE player_id = $1 ORDER BY created_at', [playerId]);
  return rows;
}

// Revocation is self-service: caller must hold a valid device of the SAME player.
async function revokeDevice(pool, actorPlayerId, deviceId) {
  const r = await pool.query('UPDATE player_devices SET revoked_at = now() WHERE device_id = $1 AND player_id = $2 AND revoked_at IS NULL', [deviceId, actorPlayerId]);
  return r.rowCount === 1;
}

module.exports = { createIdentity, recover, verifyDevice, listDevices, revokeDevice, MAX_FAILS };
