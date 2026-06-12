import { sql } from "../../lib/db.js";
import { getSessionUserId, ensureGuest } from "../../lib/subject.js";
import { effectiveTier } from "../../lib/tiers.js";
import { getQuotaStatus } from "../../lib/quota.js";

// Returns the current identity + quota status. Mints a guest cookie if needed,
// so this doubles as the boot/hydrate call for the client.
export default async function handler(req, res) {
  try {
    const uid = await getSessionUserId(req);
    if (uid) {
      const { rows } = await sql`
        SELECT id, email, tier, subscription_status FROM users WHERE id = ${uid}`;
      const user = rows[0];
      if (user) {
        const tierId = effectiveTier(user);
        const status = await getQuotaStatus(`user:${user.id}`, tierId);
        return res.status(200).json({
          user: { email: user.email, tier: tierId },
          status: { ...status, email: user.email, signedIn: true },
        });
      }
    }
    const gid = await ensureGuest(req, res);
    const status = await getQuotaStatus(`guest:${gid}`, "guest");
    return res.status(200).json({
      user: null,
      status: { ...status, email: null, signedIn: false },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to load account." });
  }
}
