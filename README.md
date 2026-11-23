# BiteFetch API

Node 22, Express 5, TypeScript, PostgreSQL 18, Stripe (test mode only).
The web app is in the sibling repo `bitefetch-web`. The browser reaches both through nginx on http://localhost:8080.

## First setup

```powershell
npm install
copy .env.example .env        # fill in the values (each one is explained in .env.example)
npm run migrate:up
npm run seed                  # seed accounts, password Password123!
```

Test database: set `DB_NAME_TEST`, then `npm run migrate:test:up`.

## Running locally (5 processes)

| # | Where | Command | Port |
|---|---|---|---|
| 1 | bitefetch-api | `npm run dev` (HTTP only) | 3000 |
| 2 | bitefetch-api | `npm run worker` (time-based jobs) | — |
| 3 | bitefetch-web | `npm run dev` | 5173 |
| 4 | nginx | `nginx -c <full path to>\deploy\nginx\dev.conf` | 8080 |
| 5 | bitefetch-api | `stripe listen ...` (see below) | — |

Open http://localhost:8080. The worker (`src/worker.ts`, jobs in `src/jobs/jobList.ts`) runs everything time-based:
payment expiry, accept timeout, the payment outbox (card voids and captures), dispatch (offers, offer expiry),
Stripe reconciliation (lost webhooks), courier auto-offline and hourly retention. Without it no courier gets an offer,
nothing expires and nothing is captured. Ctrl+C stops it cleanly (waits up to 10 s for running passes).

## Stripe (test mode)

### Keys

| Key | Where | From |
|---|---|---|
| `STRIPE_SECRET_KEY=sk_test_...` | `bitefetch-api/.env` | Dashboard → Developers → API keys → Secret key |
| `STRIPE_WEBHOOK_SECRET=whsec_...` | `bitefetch-api/.env` | printed by `stripe listen` (NOT the Dashboard) |
| `VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...` | `bitefetch-web/.env` | Dashboard → Developers → API keys → Publishable key |

All three must come from the **same** Stripe sandbox. The API refuses to start with a key that is not `sk_test_`
outside production.

### Stripe CLI

Install it (https://docs.stripe.com/stripe-cli), then once:

```powershell
stripe login
```

Every time you work on payments, keep this running in its own terminal:

```powershell
stripe listen --events payment_intent.amount_capturable_updated,payment_intent.payment_failed,payment_intent.canceled,payment_intent.succeeded --forward-to localhost:3000/webhooks/stripe
```

On start it prints `Your webhook signing secret is whsec_...`. Put it in `STRIPE_WEBHOOK_SECRET` and restart the API.
The secret stays the same between runs on this machine; it can change after a new `stripe login`
(`stripe listen --print-secret` shows the current one).

Without `stripe listen`, payments succeed at Stripe but the API never hears about it:
the order stays "Waiting for payment" and expires after 15 minutes (the card hold is then released).

### Test cards

Any future expiry date, any CVC.

| Card | Result |
|---|---|
| 4242 4242 4242 4242 | authorized → order placed |
| 4000 0000 0000 9995 | declined (insufficient funds), counts as 1 of 5 attempts |
| 4000 0000 0000 0002 | declined (generic) |
| 4000 0027 6000 3184 | 3-D Secure popup, then authorized |

Payments are authorized only (manual capture). In the Dashboard they show as **Uncaptured** until delivery
captures them, or **Canceled** after a void.

### Troubleshooting

| Symptom | Cause |
|---|---|
| API log: webhook 400 `INVALID_SIGNATURE` | `STRIPE_WEBHOOK_SECRET` is not the one `stripe listen` printed; update `.env`, restart the API |
| Pay works, order stays "Waiting for payment" | `stripe listen` is not running, or forwards to the wrong port |
| Browser: `No such payment_intent` | the publishable key is from another Stripe account than the secret key |
| Page: "Payments are not configured" | `VITE_STRIPE_PUBLISHABLE_KEY` missing in `bitefetch-web/.env`, or Vite not restarted |
| `stripe trigger ...` → API log `PaymentIntent without a valid orderId` | expected: triggered test events are not our orders; useful only to check the signature works |

## Tests

```powershell
npm test                                  # everything
npx jest tests/integration/payments       # one folder
```

Tests never call Stripe: `tests/helpers/fakeStripe.ts` replaces the Stripe client with an in-memory fake
(for every test file, see `tests/helpers/stripeMock.ts`), and webhook payloads are signed with a test secret.
