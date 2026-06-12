import { sql, withTransaction } from "../../lib/db.js";
import { getSessionUserId, ensureGuest } from "../../lib/subject.js";
import { TIERS, effectiveTier } from "../../lib/tiers.js";
import { getQuotaStatus } from "../../lib/quota.js";
import { signScoreToken } from "../../lib/scoreToken.js";

function readBody(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

// The single brain: charges one credit per property (idempotent), enforces the
// windowed quota transactionally, enforces paid-only Market-Intel refresh, and
// mints a short-lived score token the data routes require.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = readBody(req);
  const propertyId = String(body.propertyId || "").trim();
  const action = String(body.action || "").trim();
  if (!propertyId) return res.status(400).json({ error: "propertyId is required" });

  try {
    // Resolve subject + effective tier.
    let subject, tierId, email = null, signedIn = false;
    const uid = await getSessionUserId(req);
    if (uid) {
      const { rows } = await sql`SELECT id, email, subscription_status FROM users WHERE id = ${uid}`;
      const user = rows[0];
      if (user) { subject = `user:${user.id}`; tierId = effectiveTier(user); email = user.email; signedIn = true; }
    }
    if (!subject) { const gid = await ensureGuest(req, res); subject = `guest:${gid}`; tierId = "guest"; }

    const tier = TIERS[tierId] || TIERS.guest;

    const outcome = await withTransaction(async (client) => {
      // 1. Idempotent credit insert — a 2nd action on the same property conflicts (no charge).
      const ins = await client.sql`
        INSERT INTO score_ledger (subject, property_id)
        VALUES (${subject}, ${propertyId})
        ON CONFLICT (subject, property_id) DO NOTHING
        RETURNING id`;
      const isNewCredit = ins.rowCount === 1;

      // 2. Enforce the windowed quota only when a new credit was actually charged.
      if (isNewCredit) {
        let used;
        if (tier.windowSeconds == null) {
          const { rows } = await client.sql`SELECT COUNT(*)::int AS used FROM score_ledger WHERE subject = ${subject}`;
          used = rows[0].used;
        } else {
          const { rows } = await client.sql`
            SELECT COUNT(*)::int AS used FROM score_ledger
            WHERE subject = ${subject}
              AND created_at > now() - (${tier.windowSeconds} || ' seconds')::interval`;
          used = rows[0].used;
        }
        if (used > tier.limit) {
          await client.sql`DELETE FROM score_ledger WHERE subject = ${subject} AND property_id = ${propertyId}`;
          return { blocked: "quota" };
        }
      }

      // 3. Paid-only Market-Intel refresh: the 2nd+ market-intel call on a property requires paid.
      if (action === "market-intel") {
        const { rows } = await client.sql`
          SELECT COUNT(*)::int AS n FROM action_log
          WHERE subject = ${subject} AND property_id = ${propertyId} AND action = 'market-intel'`;
        if (rows[0].n >= 1 && !tier.paidFeatures) return { blocked: "paid" };
      }

      // 4. Log the action (powers the refresh check above).
      if (action) {
        await client.sql`INSERT INTO action_log (subject, property_id, action) VALUES (${subject}, ${propertyId}, ${action})`;
      }
      return { ok: true };
    });

    const status = { ...(await getQuotaStatus(subject, tierId)), email, signedIn };

    if (outcome.blocked === "quota") return res.status(429).json({ error: "quota_exceeded", status });
    if (outcome.blocked === "paid")  return res.status(402).json({ error: "paid_required", status });

    const scoreToken = await signScoreToken({ subject, propertyId });
    return res.status(200).json({ scoreToken, status });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not score property." });
  }
}
