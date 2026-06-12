import { sql } from "../../lib/db.js";

// Idempotent schema migration, guarded by MIGRATE_SECRET.
// Run once after first deploy:  GET /api/admin/migrate?secret=<MIGRATE_SECRET>
export default async function handler(req, res) {
  const secret = process.env.MIGRATE_SECRET;
  if (!secret || req.query.secret !== secret) return res.status(403).json({ error: "forbidden" });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        subscription_status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS score_ledger (
        id BIGSERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        property_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (subject, property_id)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ledger_subject_time ON score_ledger (subject, created_at)`;
    await sql`
      CREATE TABLE IF NOT EXISTS action_log (
        id BIGSERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        property_id TEXT NOT NULL,
        action TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_action_prop ON action_log (subject, property_id, action)`;

    return res.status(200).json({ ok: true, migrated: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Migration failed" });
  }
}
