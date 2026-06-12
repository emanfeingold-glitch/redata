import Stripe from "stripe";
import { sql } from "../../lib/db.js";
import { getSessionUserId } from "../../lib/subject.js";

// Starts a Stripe Checkout subscription for the $15/mo plan (STRIPE_PRICE_ID).
// Returns { configured:false } until Stripe keys are set, so the UI can show a
// "billing not connected" message without breaking.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const uid = await getSessionUserId(req);
  if (!uid) return res.status(401).json({ error: "Sign in to upgrade." });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) return res.status(200).json({ configured: false });

  try {
    const stripe = new Stripe(secretKey);
    const { rows } = await sql`SELECT id, email, stripe_customer_id FROM users WHERE id = ${uid}`;
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: String(user.id) } });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user.id}`;
    }

    const base = process.env.APP_URL || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/?upgraded=1`,
      cancel_url: `${base}/?canceled=1`,
      client_reference_id: String(user.id),
    });

    return res.status(200).json({ configured: true, url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not start checkout." });
  }
}
