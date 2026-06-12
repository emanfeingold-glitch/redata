import { sql } from "../../lib/db.js";
import {
  hashPassword, verifyPassword, signSession,
  buildCookie, clearCookie, appendCookie,
  SESSION_COOKIE, SESSION_MAX_AGE,
} from "../../lib/auth.js";
import { getSessionUserId, ensureGuest } from "../../lib/subject.js";
import { effectiveTier } from "../../lib/tiers.js";
import { getQuotaStatus } from "../../lib/quota.js";

// One serverless function serving /api/auth/<action>. Consolidated from separate
// signup/login/logout/me files to stay under Vercel Hobby's 12-function limit.
// The guest cookie is minted by `me` (no separate guest endpoint needed).
export default async function handler(req, res) {
  switch (req.query.action) {
    case "signup": return signup(req, res);
    case "login":  return login(req, res);
    case "logout": return logout(req, res);
    case "me":     return me(req, res);
    default:       return res.status(404).json({ error: "Unknown auth action" });
  }
}

function readBody(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

async function signup(req, res) {
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

async function login(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = readBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  try {
    const { rows } = await sql`SELECT id, email, password_hash, tier FROM users WHERE email = ${email}`;
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

async function logout(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  appendCookie(res, clearCookie(SESSION_COOKIE));
  return res.status(200).json({ ok: true });
}

// Returns the current identity + quota status. Mints a guest cookie if needed,
// so this doubles as the boot/hydrate call for the client.
async function me(req, res) {
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
