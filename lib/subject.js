// Resolve "who is acting" from cookies. A subject is either 'user:<id>' (signed
// session) or 'guest:<guestId>' (signed guest cookie). Cookie reads only — no DB.
import { randomBytes } from "node:crypto";
import {
  parseCookies, verifySession, verifyGuest, signGuest,
  buildCookie, appendCookie, SESSION_COOKIE, GUEST_COOKIE, GUEST_MAX_AGE,
} from "./auth.js";

export async function getSessionUserId(req) {
  const c = parseCookies(req)[SESSION_COOKIE];
  if (!c) return null;
  try { return (await verifySession(c)).uid || null; } catch { return null; }
}

export async function getGuestId(req) {
  const c = parseCookies(req)[GUEST_COOKIE];
  if (!c) return null;
  try { return (await verifyGuest(c)).gid || null; } catch { return null; }
}

// Returns an existing guest id, or mints one and sets the cookie on `res`.
export async function ensureGuest(req, res) {
  let gid = await getGuestId(req);
  if (!gid) {
    gid = "g_" + randomBytes(12).toString("hex");
    appendCookie(res, buildCookie(GUEST_COOKIE, await signGuest(gid), GUEST_MAX_AGE));
  }
  return gid;
}

// Read-only subject resolution (no mint). Used by the locked-down data routes.
export async function resolveSubject(req) {
  const uid = await getSessionUserId(req);
  if (uid) return { subject: `user:${uid}`, userId: uid, guestId: null };
  const gid = await getGuestId(req);
  if (gid) return { subject: `guest:${gid}`, userId: null, guestId: gid };
  return { subject: null, userId: null, guestId: null };
}
