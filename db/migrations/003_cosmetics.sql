-- 003_cosmetics.sql - cosmetics inventory, independent from achievements (draft)
-- A cosmetic only answers "is this item unlocked for this player". Sources may be
-- achievements today, events/promos tomorrow - no schema change needed.

CREATE TABLE IF NOT EXISTS cosmetics (
  cosmetic_id TEXT PRIMARY KEY,                 -- avatar_sand_guardian | title_sand_guardian | fx_sand_trail | ...
  kind        TEXT NOT NULL,                    -- avatar | title | effect | entrance | win_animation
  name_ar     TEXT NOT NULL,
  rarity      TEXT NOT NULL DEFAULT 'common',   -- common | rare | legendary
  source      TEXT NOT NULL DEFAULT 'default'   -- 'default' | 'achievement:<ach_id>' | future sources
);

CREATE TABLE IF NOT EXISTS player_cosmetics (
  player_id     TEXT NOT NULL REFERENCES players(player_id),
  cosmetic_id   TEXT NOT NULL REFERENCES cosmetics(cosmetic_id),
  unlocked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_detail TEXT,                           -- e.g. the achievement that granted it
  PRIMARY KEY (player_id, cosmetic_id)          -- idempotent grants
);

-- Starter set: the 12 existing in-game avatars as default cosmetics.
INSERT INTO cosmetics (cosmetic_id, kind, name_ar, rarity, source) VALUES
  ('avatar_fox',    'avatar', 'ثعلب',   'common', 'default'),
  ('avatar_panda',  'avatar', 'باندا',  'common', 'default'),
  ('avatar_frog',   'avatar', 'ضفدع',   'common', 'default'),
  ('avatar_lion',   'avatar', 'أسد',    'common', 'default'),
  ('avatar_rabbit', 'avatar', 'أرنب',   'common', 'default'),
  ('avatar_tiger',  'avatar', 'نمر',    'common', 'default'),
  ('avatar_monkey', 'avatar', 'قرد',    'common', 'default'),
  ('avatar_owl',    'avatar', 'بومة',   'common', 'default'),
  ('avatar_octopus','avatar', 'أخطبوط', 'common', 'default'),
  ('avatar_wolf',   'avatar', 'ذئب',    'common', 'default'),
  ('avatar_unicorn','avatar', 'يونيكورن','common', 'default'),
  ('avatar_bee',    'avatar', 'نحلة',   'common', 'default')
ON CONFLICT (cosmetic_id) DO NOTHING;
