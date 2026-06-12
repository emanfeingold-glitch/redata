// The single gate the locked-down data routes call first. Verifies the score
// token (signature + expiry), and that it belongs to this caller and property.
import { verifyScoreToken } from "./scoreToken.js";
import { resolveSubject } from "./subject.js";

export async function authorize(req, { propertyId } = {}) {
  const token = req.headers["x-score-token"];
  if (!token) return { ok: false, status: 401, code: "token_required" };

  let claims;
  try { claims = await verifyScoreToken(token); }
  catch { return { ok: false, status: 401, code: "token_invalid" }; } // also covers expiry

  const { subject } = await resolveSubject(req);
  if (!subject || claims.subject !== subject) {
    return { ok: false, status: 403, code: "token_subject_mismatch" };
  }
  if (propertyId && claims.propertyId !== propertyId) {
    return { ok: false, status: 403, code: "token_property_mismatch" };
  }
  return { ok: true, subject, propertyId: claims.propertyId };
}
