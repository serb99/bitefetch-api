# bitefetch-api

Food-delivery learning project by Șerban (QA → backend/DevOps; Windows, PowerShell 7, Postgres 18).
Two separate repos: `bitefetch-api` (Node 22, Express 5, TypeScript, pg, Zod) and
`bitefetch-web` (Vite, React, TS, react-router-dom; unstyled on purpose, styling pass later).

## How we work
- Claude gives me the code piece by piece, in the order of the logic (schema → service → controller → route),
  and I paste it. Each piece comes with: what it does, why it is built this way (the decision and the
  alternative that was rejected), and a concrete example. One piece per message; I say "next" for the following one.
- Short and clear answers. Explain concepts with examples, not theory.
- When I paste code back, review it and point out bugs, don't rewrite it.
- I run git myself. Never commit or push.
- Do not run the full test suite or the server. Tests for each milestone are written at the end of it.
- Don't change src when writing tests; report bugs instead.

## Where the truth lives
- Milestone tracker: docs/design/implementation-plan.md (git-ignored). "Current state" is the section below.
- Money is integer minor units (EUR cents). Ids are bigint → strings in JSON.
- Errors: AppError(status, code, message, details?), sent as `{ error: { code, message, details } }` (details null when absent).

## Endpoints (src/app.ts mounts src/routes/*)
Paths as Express sees them; the browser calls them through nginx with an `/api` prefix.
- Accounts: POST /customers, /restaurant-owners, /couriers, /account-activations
- Sessions: POST /sessions (login), POST /sessions/refresh (cookie), DELETE /sessions/current
- Password reset: POST /password-resets, POST /password-reset-confirmations
- GET /me (auth)
- Browse: GET /restaurants?lat&lng&radiusKm, GET /restaurants/:id/menu
- OSM: GET /osm/restaurants, GET /osm/addresses?q (rate limited)
- Owner (restaurant_owner): GET|PATCH /owner/restaurant; GET|POST /owner/menu-items, PATCH /owner/menu-items/:id,
  PUT /owner/menu-items/:id/availability
- Customer only:
  - GET|POST /addresses, PATCH|DELETE /addresses/:id, PUT /addresses/:id/default
  - GET|DELETE /cart, PUT|DELETE /cart/items/:menuItemId (body { restaurantId, quantity }), PUT /cart/address { addressId }
  - POST /orders (header Idempotency-Key, body { expectedTotalMinor }; 201 new, 200 replay),
    GET /orders?limit&before, GET /orders/:id

## Error codes
- 400: VALIDATION_ERROR, INVALID_INPUT, INVALID_JSON, INVALID_OR_EXPIRED_TOKEN
- 401: UNAUTHENTICATED, ACCESS_TOKEN_EXPIRED, INVALID_CREDENTIALS, INVALID_REFRESH_TOKEN, SESSION_ENDED
- 403: FORBIDDEN, ACCOUNT_NOT_ACTIVE, NO_RESTAURANT, BRAND_NOT_EDITABLE
- 404: NOT_FOUND, USER_NOT_FOUND, RESTAURANT_NOT_FOUND, MENU_ITEM_NOT_FOUND, ADDRESS_NOT_FOUND, ORDER_NOT_FOUND, PLACE_NOT_FOUND
- 409: CONFLICT, CONSTRAINT_VIOLATION, REFERENCE_VIOLATION, EMAIL_TAKEN, REFRESH_IN_PROGRESS, RESTAURANT_ALREADY_CLAIMED,
  RESTAURANT_AUTO_PAUSED, RESTAURANT_UNAVAILABLE, RESTAURANT_CLOSED, ADDRESS_LIMIT, CART_EMPTY, CART_NO_ADDRESS,
  CART_OTHER_RESTAURANT, ITEM_UNAVAILABLE, PRICE_CHANGED
- 413: PAYLOAD_TOO_LARGE · 422: ADDRESS_OUT_OF_RANGE, MIN_ORDER_NOT_MET, NO_ROUTE · 429: RATE_LIMITED
- 500: INTERNAL_ERROR · 502: OSM_UNAVAILABLE, ROUTING_UNAVAILABLE

## Env vars (.env; every process.env read in src and config)
PORT (default 3000), DB_HOST, DB_PORT, DB_NAME, DB_NAME_TEST, DB_USER, DB_PASSWORD, JWT_SECRET (required),
FRONTEND_URL (nginx address, http://localhost:8080 in dev), OSM_USER_AGENT, OSM_COUNTRIES, OSM_MIN_GAP_MS,
OSRM_BASE_URL (default https://router.project-osrm.org), OSRM_MIN_GAP_MS, RATE_LIMIT_DISABLED, LOG_LEVEL, NODE_ENV.

# Current state

## Done
- M1–M3: auth (JWT access + refresh, 401 retry on the web), roles (customer, owner, courier, admin),
  restaurants/brands/menus, OSM search + import, owner claim flow, manual restaurant. M3 tests pass.
- M4 (done): delivery addresses CRUD (max 10; deleting the default promotes the newest remaining),
  cart (one per customer, row lock, one restaurant at a time), OSRM route + route_cache (7 days),
  delivery fee (150 cents up to 3 km + 40 per started extra km, max route 7000 m),
  checkout (POST /orders, Idempotency-Key header, expectedTotalMinor → 409 PRICE_CHANGED,
  order_code BF-XXXXX, snapshots, status history), GET /orders and GET /orders/:id.
  Tests: tests/integration/orders/* + tests/unit/deliveryFee.test.ts (helpers in tests/helpers/customer.ts).
- Web: login + session restore, header (profile, cartoon Orders and Cart buttons), address search,
  nearby restaurants, menu page with cartoon "Add", cart context, addresses page, cart page,
  checkout (PlaceOrderButton, per-attempt Idempotency-Key), order page, orders list (Load more).

## Next
1. Try the checkout in the browser (manual flows A–H from the M4 session; not done yet).
2. M5 Stripe payment (orders stay pending_payment until then).

## Parked
- Admin approve (M11) must copy openingHours from application details into the restaurant.
- Retention jobs for osm_search_cache / route_cache (M13); courier vehicle ETA factor (M7).