import { ensureGuest } from "../../lib/subject.js";

// Mints the signed guest cookie if one isn't present. Safe to call on every boot.
export default async function handler(req, res) {
  try {
    const guestId = await ensureGuest(req, res);
    return res.status(200).json({ guestId });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Guest init failed." });
  }
}
