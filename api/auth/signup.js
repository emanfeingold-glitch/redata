import { sql } from "../../lib/db.js";
import {
  hashPassword, signSession, buildCookie, appendCookie,
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

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  try {
    const hash = await hashPassword(password);
    const { rows } = await sql`
      INSERT INTO users (email, password_hash, tier)
      VALUES (${email}, ${hash}, 'free')
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email, tier`;
    if (rows.length === 0) {
      return res.status(409).json({ error: "An account with that email already exists. Try signing in." });
    }
    const user = rows[0];
    appendCookie(res, buildCookie(SESSION_COOKIE, await signSession(user.id), SESSION_MAX_AGE));
    return res.status(200).json({ user: { email: user.email, tier: user.tier } });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Sign up failed." });
  }
}
