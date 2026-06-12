import { sql } from "../../lib/db.js";
import {
  verifyPassword, signSession, buildCookie, appendCookie,
  SESSION_COOKIE, SESSION_MAX_AGE,
} from "../../lib/auth.js";

function readBody(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  try {
    const { rows } = await sql`
      SELECT id, email, password_hash, tier FROM users WHERE email = ${email}`;
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    appendCookie(res, buildCookie(SESSION_COOKIE, await signSession(user.id), SESSION_MAX_AGE));
    return res.status(200).json({ user: { email: user.email, tier: user.tier } });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Sign in failed." });
  }
}
