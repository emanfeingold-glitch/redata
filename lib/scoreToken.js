// Short-lived, signed token proving a credit was consumed for (subject, propertyId).
// Issued by /api/credit/consume; required by the locked-down data routes.
import { SignJWT, jwtVerify } from "jose";

function secret() {
  const v = process.env.SCORE_TOKEN_SECRET;
  if (!v) throw new Error("SCORE_TOKEN_SECRET is not configured");
  return new TextEncoder().encode(v);
}

export async function signScoreToken({ subject, propertyId }) {
  return new SignJWT({ sub: subject, pid: propertyId })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("10m")
    .sign(secret());
}

export async function verifyScoreToken(token) {
  const { payload } = await jwtVerify(token, secret());
  return { subject: payload.sub, propertyId: payload.pid };
}
