-- Iron Arena accounts (Postgres). Idempotent; applied on boot by the migration runner.
-- Identity + scalars are real columns; collection-shaped data (unlock sets, claimed
-- rewards, extensible stats, loadout) are JSONB so new stats/categories need no migration.
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'guest',
  username        TEXT,
  username_lower  TEXT,
  token_hash      TEXT NOT NULL,
  token_salt      TEXT NOT NULL,
  pass_hash       TEXT,
  pass_salt       TEXT,
  display_name    TEXT NOT NULL DEFAULT '',
  created_at      BIGINT NOT NULL,
  last_seen       BIGINT NOT NULL,
  xp              INTEGER NOT NULL DEFAULT 0,
  currency        INTEGER NOT NULL DEFAULT 0,
  claimed_rewards JSONB NOT NULL DEFAULT '[]',
  unlocks         JSONB NOT NULL DEFAULT '{}',
  loadout         JSONB NOT NULL DEFAULT '{}',
  stats           JSONB NOT NULL DEFAULT '{}'
);
-- A UNIQUE index permits many NULLs, so guests (no username) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_uq ON accounts (username_lower);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  expires_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
