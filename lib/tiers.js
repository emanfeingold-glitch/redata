// Server-side mirror of the client TIERS (public/user-system.js). Keep limits in sync.
const HOUR = 3600;

export const TIERS = {
  guest: { id: "guest", label: "Guest", limit: 5,   windowSeconds: null,     paidFeatures: false },
  free:  { id: "free",  label: "Free",  limit: 10,  windowSeconds: 4 * HOUR, paidFeatures: false },
  paid:  { id: "paid",  label: "Pro",   limit: 100, windowSeconds: HOUR,     paidFeatures: true  },
};

export function tierFor(id) {
  return TIERS[id] || TIERS.guest;
}

// A user's effective tier is derived from their Stripe subscription status.
export function effectiveTier(user) {
  if (!user) return "guest";
  const s = user.subscription_status;
  return (s === "active" || s === "trialing") ? "paid" : "free";
}
