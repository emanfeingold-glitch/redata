import { clearCookie, appendCookie, SESSION_COOKIE } from "../../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  appendCookie(res, clearCookie(SESSION_COOKIE));
  return res.status(200).json({ ok: true });
}
