import Stripe from "stripe";
import { sql } from "../../lib/db.js";

// Stripe requires the EXACT raw body bytes to verify the signature — disable the
// body parser and read the stream manually. Never JSON.parse before constructEvent.
export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !whSecret) return res.status(500).json({ error: "Stripe not configured" });

  const stripe = new Stripe(secretKey);
  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], whSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature: ${err.message}` });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.client_reference_id) {
          await sql`
            UPDATE users
            SET stripe_subscription_id = ${s.subscription},
                stripe_customer_id = ${s.customer},
                subscription_status = 'active',
                tier = 'paid'
            WHERE id = ${s.client_reference_id}`;
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const tier = (sub.status === "active" || sub.status === "trialing") ? "paid" : "free";
        await sql`
          UPDATE users
          SET subscription_status = ${sub.status},
              stripe_subscription_id = ${sub.id},
              tier = ${tier}
          WHERE stripe_customer_id = ${sub.customer}`;
        break;
      }
      default:
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Webhook handler failed" });
  }
}
