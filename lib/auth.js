// Auth primitives: scrypt password hashing, jose session/guest JWTs, cookie helpers.
// No external hashing dep — Node's built-in crypto.scrypt is used.
import { scrypt as _scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";

const scrypt = promisify(_scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const SESSION_COOKIE = "rd_session";
export const GUEST_COOKIE = "rd_guest";
export const SESSION_MAX_AGE = 30 * 24 * 3600;   // 30 days
export const GUEST_MAX_AGE = 365 * 24 * 3600;    // 1 year

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}
function sessionSecret() { return new TextEncoder().encode(requireEnv("AUTH_JWT_SECRET")); }

// ---- Password hashing ----------------------------------------------------
export async function hashPassword(pw) {
  const salt = randomBytes(32);
  const dk = await scrypt(String(pw), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const dk = await scrypt(String(pw), salt, expected.length, { N: +n, r: +r, p: +p });
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  } catch { return false; }
}

// ---- Session / guest tokens ---------------------------------------------
export async function signSession(userId) {
  return new SignJWT({ uid: String(userId) })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30d")
    .sign(sessionSecret());
}
export async function verifySession(token) {
  const { payload } = await jwtVerify(token, sessionSecret());
  return payload; // { uid }
}
export async function signGuest(guestId) {
  return new SignJWT({ gid: String(guestId) })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("365d")
    .sign(sessionSecret());
}
export async function verifyGuest(token) {
  const { payload } = await jwtVerify(token, sessionSecret());
  return payload; // { gid }
}

// ---- Cookies -------------------------------------------------------------
export function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}
// `Secure` is omitted off-production so cookies persist on http://localhost (vercel dev).
const secureFlag = () => (process.env.NODE_ENV === "production" ? "; Secure" : "");
export function buildCookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureFlag()}`;
}
export function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`;
}
export function appendCookie(res, cookieStr) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", [cookieStr]);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", [...prev, cookieStr]);
  else res.setHeader("Set-Cookie", [prev, cookieStr]);
}
