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
- Stripe: POST /webhooks/stripe (raw body, Stripe-Signature header; mounted before express.json; dedupe in stripe_events)
- Owner (restaurant_owner): GET|PATCH /owner/restaurant; GET|POST /owner/menu-items, PATCH /owner/menu-items/:id,
  PUT /owner/menu-items/:id/availability
- Owner orders (restaurant_owner, M6; the restaurant comes from the owner, another restaurant's order → 404 ORDER_NOT_FOUND):
  - GET /owner/orders: the kitchen board. placed (minus past-deadline ones), accepted, ready_for_pickup; most urgent first
    (placed by accept_deadline, accepted by estimated_ready_at, ready by ready_at). Items as { name, quantity }, no customer data.
  - POST /owner/orders/:id/accept { prepMinutes? 10-60 step 5, default prep_minutes_default } (T6; body may be absent)
    → 409 ACCEPT_WINDOW_OVER after accept_deadline.
  - POST /owner/orders/:id/reject { reasonCode: out_of_stock|too_busy|closing_soon|other, note? (required for other) } (T7)
  - POST /owner/orders/:id/ready (T10), POST /owner/orders/:id/cancel { reasonCode: out_of_stock|kitchen_issue|too_busy|other, note? } (T11, only while accepted)
  - All four: 200 with the order's new state, the same body on a repeat (double click); wrong status → 409 ORDER_STATUS_CHANGED with details.status.
- Customer only:
  - GET|POST /addresses, PATCH|DELETE /addresses/:id, PUT /addresses/:id/default
  - GET|DELETE /cart, PUT|DELETE /cart/items/:menuItemId (body { restaurantId, quantity }), PUT /cart/address { addressId }
  - POST /orders (header Idempotency-Key, body { expectedTotalMinor }; 201 new, 200 replay; response = order + clientSecret,
    null if Stripe failed), GET /orders?limit&before, GET /orders/:id (database only, never calls Stripe),
    GET /orders/:id/payment → { clientSecret } (creates or retrieves the PaymentIntent; 409 ORDER_NOT_PAYABLE if not pending_payment),
    POST /orders/:id/cancel (T5 while pending_payment → abandoned_checkout + cart restored; T9 while placed → customer_cancelled,
    no cart restore; 200 with the order, also on a repeat; from accepted on 409 ORDER_NOT_CANCELLABLE with details.status).
    The order view also has paymentAttempts, maxPaymentAttempts, lastPaymentError, cancelReason.

## Error codes
- 400: VALIDATION_ERROR, INVALID_INPUT, INVALID_JSON, INVALID_OR_EXPIRED_TOKEN, INVALID_SIGNATURE (Stripe webhook)
- 401: UNAUTHENTICATED, ACCESS_TOKEN_EXPIRED, INVALID_CREDENTIALS, INVALID_REFRESH_TOKEN, SESSION_ENDED
- 403: FORBIDDEN, ACCOUNT_NOT_ACTIVE, NO_RESTAURANT, BRAND_NOT_EDITABLE
- 404: NOT_FOUND, USER_NOT_FOUND, RESTAURANT_NOT_FOUND, MENU_ITEM_NOT_FOUND, ADDRESS_NOT_FOUND, ORDER_NOT_FOUND, PLACE_NOT_FOUND
- 409: CONFLICT, CONSTRAINT_VIOLATION, REFERENCE_VIOLATION, EMAIL_TAKEN, REFRESH_IN_PROGRESS, RESTAURANT_ALREADY_CLAIMED,
  RESTAURANT_AUTO_PAUSED, RESTAURANT_UNAVAILABLE, RESTAURANT_CLOSED, ADDRESS_LIMIT, CART_EMPTY, CART_NO_ADDRESS,
  CART_OTHER_RESTAURANT, ITEM_UNAVAILABLE, PRICE_CHANGED, ORDER_NOT_PAYABLE, ORDER_NOT_CANCELLABLE,
  ORDER_STATUS_CHANGED, ACCEPT_WINDOW_OVER (CONSTRAINT_VIOLATION is also what the DB transition guard gives, should a service ever slip)
- 413: PAYLOAD_TOO_LARGE · 422: ADDRESS_OUT_OF_RANGE, MIN_ORDER_NOT_MET, NO_ROUTE · 429: RATE_LIMITED
- 500: INTERNAL_ERROR · 502: OSM_UNAVAILABLE, ROUTING_UNAVAILABLE, PAYMENT_UNAVAILABLE

## Env vars (.env; every process.env read in src and config)
PORT (default 3000), DB_HOST, DB_PORT, DB_NAME, DB_NAME_TEST, DB_USER, DB_PASSWORD, JWT_SECRET (required),
FRONTEND_URL (nginx address, http://localhost:8080 in dev), OSM_USER_AGENT, OSM_COUNTRIES, OSM_MIN_GAP_MS,
OSRM_BASE_URL (default https://router.project-osrm.org), OSRM_MIN_GAP_MS, RATE_LIMIT_DISABLED, LOG_LEVEL, NODE_ENV,
STRIPE_SECRET_KEY (required; must start with sk_test_ outside production), STRIPE_WEBHOOK_SECRET (required; whsec_ from `stripe listen`).

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

## Done: M5 Stripe (2026-11-20)
Stripe sandbox "BiteFetch", Stripe CLI, `stripe@23` (create param is `allowed_payment_method_types`).
How to run it locally (keys, `stripe listen`, test cards, troubleshooting): README.md.
- stripeClient.ts (sk_test_ guard, 2 retries, 10 s timeout). paymentService: ensurePaymentIntent (manual capture, card only,
  key order:{id}:pi, created after the checkout COMMIT, client secret never stored), voidPayment (Stripe key
  order:{id}:void:{attempt}, "already canceled" = success → payment_status voided), capturePayment (key
  order:{id}:capture:{attempt}, capture_attempts, gives up after capture_auto_retries → capture_failed + incident, only if delivered).
- Webhook (webhookService): stripe_events dedupe + handler in one transaction, actor system:stripe.
  T3 amount_capturable_updated → placed (+ accept_deadline, outbox order.placed for M10; late after expiry/cancel → void).
  T2 payment_failed → payment_attempts + 1, last_payment_error (200 chars); the 5th → expired too_many_attempts.
- outbox.ts (enqueueOutbox, queuePaymentVoid key order:{id}:void → one void per order) and paymentOutbox.ts
  (processPaymentOutbox: max 10 rows per pass, FOR UPDATE SKIP LOCKED + 120 s lease, backoff 30 s doubling to 1 h).
- paymentExpiry.ts: expireOrder (T4, used by the sweep and the 5th decline) and expirePendingPayments (sweep, one
  transaction per order, SKIP LOCKED, max 50, actor system:expiry).
- orderCancelService.ts: T5 (M6: cancelCustomerOrder, also T9). T4 and T5 restore the cart with cartService.restoreCartFromOrder
  (only into an empty cart; sets carts.restaurant_id BEFORE the items because of the cart_items_brand_check trigger).
- jobs/paymentJobs.ts: 5 s timer (expiry, then outbox), started only in server.ts (not in tests). Moves to the worker in M8.
- Tests: tests/integration/payments/* (45). Stripe is faked for EVERY test file: tests/helpers/fakeStripe.ts +
  stripeMock.ts (setupFilesAfterEnv); signed webhooks and order helpers in tests/helpers/payments.ts.
- Web: Payment Element on OrderPage while pending_payment (PaymentSection + PaymentForm, polling every 3 s,
  time left, attempts left, Cancel), checkout passes the clientSecret in router state.

  Manual test-mode run in the browser done 2026-11-21 (4242 → placed, 9995 → decline, Cancel, expiry). Gotchas:
  `stripe listen --api-key <sk_test_ from .env>` (the CLI login was a different account); restart the API after
  changing .env (tsx watch does not reload it).

## Done: M6 Restaurant order handling (2026-11-21, API only)
- orderTransition.ts: lockOrder(client, id, { customerId } | { restaurantId }) = SELECT ... FOR UPDATE scoped to the
  caller (404 ORDER_NOT_FOUND otherwise) + assertStatus(order, allowed, code?, message?) → 409 with details.status.
  This is the "central transition" helper; each service writes its own UPDATE (the columns differ per T).
- ownerOrderService.ts: listOwnerActiveOrders (board), acceptOrder T6 (accept_deadline > now() in the UPDATE,
  dispatch_after = greatest(now, ready − dispatch_lead_s), dispatch_state not_started), rejectOrder T7, markOrderReady T10
  (dispatch_after = least(dispatch_after, now), resolves kitchen_late), ownerCancelOrder T11 (withdraws a pending offer,
  courier_id NULL, resolves kitchen_late). T6/T7 reset restaurants.consecutive_timeouts unless auto-paused.
  Every action is idempotent for the same actor (repeat → 200 with the stored state). Void via queuePaymentVoid (outbox).
- acceptTimeout.ts: T8 rejectTimedOutOrders (sweep, SKIP LOCKED, max 50, actor system:accept-timeout,
  restaurant_timeout); counts consecutive_timeouts; at AUTO_PAUSE_TIMEOUTS (2) pauses 30 days and opens one
  restaurant_unresponsive incident (ON CONFLICT on order_incidents_restaurant_open_uq). Runs in jobs/paymentJobs.ts
  (expiry → accept timeout → outbox).
- DB guard orders_transition_guard (migration 9) already matched §2.1 1:1; no migration needed.
- Decision: no optimistic version check on owner actions (FOR UPDATE + status check is the right test for "from placed");
  expectedVersion comes with the admin endpoints in M11 (T14-T17), where the admin acts on a page read earlier.
- Tests: tests/integration/restaurantOrders/* (83, helpers in tests/helpers/restaurantOrders.ts):
  transitionGuard (9 x 9 matrix in SQL: 13 allowed, 59 refused, T1 insert rule, T2 self-loop), accept, reject, ready,
  ownerCancel, acceptTimeout, customerCancel (T9), board, races (accept vs cancel/reject, ready vs cancel, sweep vs cancel).
  resetAccountTables now also deletes order_offers. payments/cancel.test.ts: the "409 once placed" case became T9.
  Jest note: testMatch globs skip dot folders, so tests do not run from a checkout under .claude/worktrees.

## Next
1. M7 (dispatch and courier delivery). Start with a short brainstorm (scope + decisions), then pieces.
2. Web for M6 (owner board: list + accept/reject/ready/cancel, polling) — Șerban does it later.
Known gaps left on purpose: reconciliation sweeper for lost webhooks (M8); live updates instead of polling (M10);
owner actions do not re-check users.status (stateless access token, like the other owner routes); T7 "mark ticked
items unavailable" (review D1) not built.

## Parked
- Admin approve (M11) must copy openingHours from application details into the restaurant.
- Retention jobs for osm_search_cache / route_cache (M13); courier vehicle ETA factor (M7).
- Web: owner/courier/admin home page still shows the customer "Order food" section; replace with role dashboards (M6/M12).