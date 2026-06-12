# REDATA Backend Setup

The user system now runs on a real backend: accounts, sessions, and quota limits
are enforced **server-side** in Vercel Postgres, and the data routes
(`/api/attom`, `/api/parse-listing`, `/api/market-intel`) reject any call without
a valid, server-issued score token. Stripe billing is scaffolded for the $15/mo
Pro plan but inactive until you add keys.

Until you complete steps 1–4 the app will treat everyone as a guest and won't be
able to score (the calculator UI still loads; the Plans popup still works).

---

## What I need from you

1. **Create a Vercel Postgres store** and link it to this project.
2. **Set a few secrets** in the project (values below are pre-generated for you).
3. **Run the database migration** once.
4. *(Later, when you want billing live)* **Add Stripe keys + the $15 price + webhook.**

---

## 1. Provision the database

- Vercel dashboard → your project → **Storage** → **Create Database** → **Neon (Postgres)**
  (the native Neon integration injects a `DATABASE_URL` automatically).
- Make sure it's **connected to this project** so the env var is available to functions.
- The app uses the Neon serverless driver and reads `DATABASE_URL` (falling back to
  `POSTGRES_URL` if you migrated from a legacy Vercel Postgres store), so either works.

## 2. Set environment variables

In **Project → Settings → Environment Variables** (and in `.env.local` for local
`vercel dev`), add:

```
AUTH_JWT_SECRET=q+q/G9tWwYhTsnT2tzM/1HM2ZQeURYT39s7aT7Eq27k=
SCORE_TOKEN_SECRET=NZfjbljRLZuujFc0mMOUcb72sgDXbDAxlJlBnnXAOgM=
MIGRATE_SECRET=f815afae8ddec021e3d808c7bd9e84ea
```

(These were generated for you. Regenerate anytime with:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.)

`DATABASE_URL` is set automatically by step 1. Your existing
`ATTOM_API_KEY`, `FRED_API_KEY`, `ANTHROPIC_API_KEY` stay as-is.

## 3. Run the migration (once)

Either:
- **Guarded route:** deploy, then open
  `https://<your-app>/api/admin/migrate?secret=<MIGRATE_SECRET>` once. It returns
  `{"ok":true,"migrated":true}` and is safe to re-run (idempotent), **or**
- **Query console:** paste [`db/schema.sql`](db/schema.sql) into the Vercel
  Postgres query console.

## 4. Stripe (only when you're ready for real billing)

1. In Stripe, create a **recurring Product/Price** at **$15/month**; copy the price id (`price_…`).
2. Add env vars:
   ```
   STRIPE_SECRET_KEY=sk_...
   STRIPE_PRICE_ID=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   APP_URL=https://<your-app>      # used for checkout redirect URLs
   ```
3. Add a webhook endpoint in Stripe pointing to `https://<your-app>/api/stripe/webhook`,
   subscribed to `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

Until these are set, the **Upgrade to Pro** button in the Plans popup shows
"Billing isn't connected yet" instead of failing.

---

## Running locally

```bash
npm install
vercel link           # link to the Vercel project (one time)
vercel env pull .env.local
vercel dev            # serves the static site + /api functions together
```

> Use `vercel dev`, not a plain static server — the app now needs the `/api`
> routes. (`npx serve public` only exercises the UI/Plans popup.)

### Granting Pro for testing without Stripe

Before billing is wired, mark a user as Pro directly in the DB to test the paid
tier / Market-Intel refresh:

```sql
UPDATE users SET tier='paid', subscription_status='active' WHERE email='you@firm.com';
```

---

## How enforcement works (reference)

- **Subject** = a signed session cookie (`user:<id>`) or a signed guest cookie
  (`guest:<id>`). Guests reset only if cookies are cleared.
- **One credit per property.** `/api/credit/consume` charges a credit
  (idempotent per `propertyId`), enforces the windowed limit
  (guest 5 total · free 10/4h · paid 100/1h) inside a transaction, and returns a
  short-lived **score token**. Reset starts a new property → new credit.
- **Lock-down.** The three data routes call `authorize()` first and reject
  missing/expired/mismatched tokens (401/403). They can't run without a consumed credit.
- **Paid-only refresh.** A 2nd+ `market-intel` call on the same property requires
  the paid tier (server returns 402 → the UI shows the upgrade prompt).
- **Tier from Stripe.** The webhook sets `subscription_status`/`tier`; a user is
  Pro while their subscription is `active`/`trialing`.

Server limits live in [`lib/tiers.js`](lib/tiers.js); keep them in sync with the
client `TIERS` in [`public/user-system.js`](public/user-system.js).
