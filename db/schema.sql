-- REDATA database schema (Vercel Postgres / Neon).
-- Apply once via the guarded route /api/admin/migrate?secret=<MIGRATE_SECRET>
-- or by pasting this file into the Vercel Postgres query console.

CREATE TABLE IF NOT EXISTS users (
  id                      BIGSERIAL PRIMARY KEY,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,                 -- scrypt$N$r$p$<saltB64>$<hashB64>
  tier                    TEXT NOT NULL DEFAULT 'free',  -- cached derivation of subscription_status
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  subscription_status     TEXT,                          -- active | trialing | past_due | canceled | null
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One credit per (subject, property). The UNIQUE constraint makes the bundled
-- 2nd/3rd API action on the same property a no-op insert (no extra charge).
CREATE TABLE IF NOT EXISTS score_ledger (
  id           BIGSERIAL PRIMARY KEY,
  subject      TEXT NOT NULL,        -- 'user:<id>' or 'guest:<guestId>'
  property_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject, property_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_subject_time ON score_ledger (subject, created_at);

-- Per-action log, used to enforce paid-only Market-Intel refresh
-- (2nd+ market-intel call on the same property requires the paid tier).
CREATE TABLE IF NOT EXISTS action_log (
  id           BIGSERIAL PRIMARY KEY,
  subject      TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  action       TEXT NOT NULL,        -- 'attom' | 'parse-listing' | 'market-intel'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_prop ON action_log (subject, property_id, action);
