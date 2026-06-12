// Computes the quota status object the client UI consumes. Shape matches the
// client's getQuotaStatus() output (minus email/signedIn, which callers add).
import { sql } from "./db.js";
import { TIERS } from "./tiers.js";

export async function getQuotaStatus(subject, tierId) {
  const t = TIERS[tierId] || TIERS.guest;
  let used = 0, resetsAt = null;

  if (subject) {
    if (t.windowSeconds == null) {
      const { rows } = await sql`SELECT COUNT(*)::int AS used FROM score_ledger WHERE subject = ${subject}`;
      used = rows[0].used;
    } else {
      const { rows } = await sql`
        SELECT COUNT(*)::int AS used,
               EXTRACT(EPOCH FROM MIN(created_at))::bigint AS oldest
        FROM score_ledger
        WHERE subject = ${subject}
          AND created_at > now() - (${t.windowSeconds} || ' seconds')::interval`;
      used = rows[0].used;
      if (rows[0].oldest) resetsAt = (Number(rows[0].oldest) + t.windowSeconds) * 1000;
    }
  }

  return {
    tier: t.id,
    label: t.label,
    used,
    limit: t.limit,
    remaining: Math.max(0, t.limit - used),
    windowMs: t.windowSeconds == null ? null : t.windowSeconds * 1000,
    resetsAt,
    paidFeatures: t.paidFeatures,
  };
}
