-- 001_identity.sql - identity foundation (draft, pending design approval)
-- Applied in order by schema_migrations. Idempotent. Never blocks game boot.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public identity. player_id grants nothing by itself; writes need a device token.
CREATE TABLE IF NOT EXISTS players (
  player_id        TEXT PRIMARY KEY,            -- 'LK-XXXX-XXXX'
  display_name     TEXT NOT NULL DEFAULT '',
  avatar_id        TEXT,                        -- equipped avatar cosmetic (slot mirror; loadout is source)
  title_id         TEXT,                        -- equipped title cosmetic
  xp               BIGINT NOT NULL DEFAULT 0,   -- level is derived in code
  recovery_hash    TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash, key never stored
  rec_attempts     INT NOT NULL DEFAULT 0,      -- consecutive failed recovery attempts
  rec_locked_until TIMESTAMPTZ,                 -- exponential lockout
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per device. Token stored as sha256 hash; revocable independently.
CREATE TABLE IF NOT EXISTS player_devices (
  device_id     TEXT PRIMARY KEY,               -- server-generated
  player_id     TEXT NOT NULL REFERENCES players(player_id),
  token_hash    TEXT NOT NULL,                  -- sha256 of the device token
  label         TEXT NOT NULL DEFAULT '',       -- e.g. device/model hint from UA
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_player ON player_devices(player_id) WHERE revoked_at IS NULL;

-- Extensible counters. New achievement -> new key, no schema change.
CREATE TABLE IF NOT EXISTS player_stats (
  player_id TEXT NOT NULL REFERENCES players(player_id),
  key       TEXT NOT NULL,                      -- wins, matches_played, best_streak, hard_bot_wins, ...
  value     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, key)
);

-- Independent equip slots (free mixing). Each slot must reference an owned cosmetic.
CREATE TABLE IF NOT EXISTS player_loadout (
  player_id            TEXT PRIMARY KEY REFERENCES players(player_id),
  avatar_cosmetic_id   TEXT,
  title_cosmetic_id    TEXT,
  effect_cosmetic_id   TEXT,
  entrance_cosmetic_id TEXT,
  win_anim_cosmetic_id TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
