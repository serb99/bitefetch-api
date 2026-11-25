# bitefetch-api

Food-delivery learning project (developer: QA → backend/DevOps; Windows, PowerShell 7, Postgres 18).
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
  - POST /owner/orders/:id/reject { reasonCode: out_of_stock|too_busy|closing_soon|other, note? (required for other),
    unavailableItemIds? (M9: menu item ids OF THIS ORDER → unavailable at this restaurant; others ignored) } (T7).
    T7 and T8 put the items back into the customer's cart (only into an empty cart).
  - POST /owner/orders/:id/ready (T10), POST /owner/orders/:id/cancel { reasonCode: out_of_stock|kitchen_issue|too_busy|other, note? } (T11, only while accepted)
  - All four: 200 with the order's new state, the same body on a repeat (double click); wrong status → 409 ORDER_STATUS_CHANGED with details.status.
  - POST /owner/orders/:id/cancel-request { same body as T11 } (T14 step 1, M9, only while ready_for_pickup) → 201 the pending
    request { id, orderId, status, reasonCode, note, version, createdAt, decidedAt }; again while one is pending → 200 with it.
- Courier (courier role + a courier_profiles row, else 403 NO_COURIER_PROFILE; the services lock the users row, so a
  suspended courier gets 403 ACCOUNT_NOT_ACTIVE; M7):
  - GET /courier: state (availability, vehicleType, positionFresh, ...).
  - PUT /courier/position { lat, lng, accuracyM?, headingDeg?, speedMps?, recordedAt (ISO with offset) } → 204. Strict body,
    one row per courier, received_at = server time. Every 3 s from the app/simulator.
  - POST /courier/availability { online } → state. Online needs a position younger than courier_fresh_position_s
    (409 POSITION_STALE, details.maxAgeS). Offline releases a pending offer (declined with reason went_offline).
  - GET /courier/offers/current → { offer | null }: restaurant, distanceToRestaurantM, deliveryDistanceM, itemCount,
    secondsLeft. No customer data before accepting (decision J).
  - POST /courier/offers/:id/accept → { offerId, orderId, orderCode, status, version, order, route } (route null if OSRM fails).
    POST /courier/offers/:id/decline { reason?: too_far|busy|vehicle_unsuitable|other }. Someone else's offer → 404 OFFER_NOT_FOUND;
    no longer pending → 409 OFFER_CLOSED (details.offerStatus); a late accept (past expires_at, sweep not run yet) →
    409 OFFER_CLOSED {offerStatus: 'expired'} and the offer stays pending until the S4 sweep expires it. Repeats → 200.
  - GET /courier/orders/current → { order | null } (accepted / ready_for_pickup / picked_up): customer first name +
    delivery address, never the phone; items; times.
  - POST /courier/orders/:id/pickup (T12, from accepted or ready_for_pickup) → order + route to the customer;
    POST /courier/orders/:id/deliver (T13, from picked_up). Both check the STORED position: older than
    courier_fresh_position_s → 409 POSITION_STALE, farther than location_check_radius_m (150) → 409 TOO_FAR_AWAY
    { distanceM, maxDistanceM }. A courier who lost the order → 409 ORDER_STATUS_CHANGED; one who never had it → 404 ORDER_NOT_FOUND.
  - POST /courier/orders/:id/problems { category: customer_unreachable|wrong_or_missing_items|vehicle_issue|restaurant_closed|other,
    note? (required for other, max 1000) } (R5, M9) → 201 the courier_problem incident { id, orderId, category, details, openedAt };
    one open per order (again → 200 with it). Own order in accepted/ready_for_pickup/picked_up; never changes the order.
- Admin (admin role + a live session: requireLiveSession; M9, one order at a time, the lists come in M11). Every action needs
  the version the admin saw → 409 VERSION_CONFLICT { status, version }; wrong state → 409 ORDER_STATUS_CHANGED { status,
  dispatchState }; audit actor admin:{id}, the reason in order_status_history. All answer with the admin order view.
  - GET /admin/orders/:id: order + version, dispatchState/Round/Deadline, courierId, times, cancel fields, incidents[], cancelRequests[].
  - POST /admin/orders/:id/cancel { reason (3-500), version } (T15, any non-terminal; cancel_reason admin_cancelled, note = reason).
  - POST /admin/orders/:id/mark-picked-up { reason, version } (T16, a courier assigned, no location check).
  - POST /admin/orders/:id/mark-delivered { reason, version } (T17, from picked_up, captures). An open courier_problem
    customer_unreachable younger than customer_unreachable_wait_s (600) → 409 CUSTOMER_WAIT_NOT_OVER { waitS, secondsLeft } (R6).
  - POST /admin/orders/:id/retry-dispatch { version } (S7, from no_courier: round + 1, new deadline, no_courier incident resolved).
  - POST /admin/orders/:id/reassign-courier { reason, version } (S8, assigned before pickup: offer withdrawn, courier_id NULL,
    searching with a new deadline, courier_problem resolved; the old courier is never offered this order again).
  - POST /admin/cancel-requests/:id/approve|reject { version } (T14 step 2; version = the REQUEST's version). Approve =
    cancelled as by the restaurant (its reason code). Unknown → 404 CANCEL_REQUEST_NOT_FOUND; decided or superseded (the
    courier picked up first) → 409 CANCEL_REQUEST_CLOSED { requestStatus, status }.
- Customer only:
  - GET|POST /addresses, PATCH|DELETE /addresses/:id, PUT /addresses/:id/default
  - GET|DELETE /cart, PUT|DELETE /cart/items/:menuItemId (body { restaurantId, quantity }), PUT /cart/address { addressId }
  - POST /orders (header Idempotency-Key, body { expectedTotalMinor }; 201 new, 200 replay; response = order + clientSecret,
    null if Stripe failed), GET /orders?limit&before, GET /orders/:id (database only, never calls Stripe),
    GET /orders/:id/payment → { clientSecret } (creates or retrieves the PaymentIntent; 409 ORDER_NOT_PAYABLE if not pending_payment),
    POST /orders/:id/cancel { note? (max 500) } (T5 while pending_payment → abandoned_checkout + cart restored; T9 while placed →
    customer_cancelled, no cart restore; M9 T18 while accepted/ready_for_pickup with dispatch_state no_courier and nobody
    assigned → cancel_reason no_courier, offer withdrawn, incident resolved; 200 with the order, also on a repeat; otherwise 409 ORDER_NOT_CANCELLABLE
    { status, dispatchState }, message "A courier just accepted this order" when assigned).
    POST /orders also refuses with 409 NO_COURIER_NEARBY when no online, active courier with a fresh position is within
    10 km of the restaurant (T1 guard, platform setting checkout_courier_check: 1 on, 0 off; 0 in the test database).
    The order view also has paymentAttempts, maxPaymentAttempts, lastPaymentError, cancelReason, cancelNote, dispatchState.
  - GET /orders/:id/tracking (M7b, polled every 3 s, database only) → { orderId, status, leg, restaurant {name,lat,lng},
    destination {lat,lng}, courier { firstName, vehicleType, position { lat, lng, headingDeg, ageS, stale } | null } | null }.
    Courier only while courier_id is set AND status is accepted/ready_for_pickup/picked_up (the status check is in the
    users JOIN's ON); leg 'to_restaurant' before pickup, 'to_customer' after, else null. stale = received_at older than
    courier_fresh_position_s.
  - GET /orders/:id/route (M7b, once per leg) → { leg, route | null }: to_restaurant = courier's position → restaurant,
    to_customer = restaurant → delivery point (cached since checkout). getRouteOrNull: null on no position, OSRM error or > 2.5 s.

## Error codes
- 400: VALIDATION_ERROR, INVALID_INPUT, INVALID_JSON, INVALID_OR_EXPIRED_TOKEN, INVALID_SIGNATURE (Stripe webhook)
- 401: UNAUTHENTICATED, ACCESS_TOKEN_EXPIRED, INVALID_CREDENTIALS, INVALID_REFRESH_TOKEN, SESSION_ENDED
- 403: FORBIDDEN, ACCOUNT_NOT_ACTIVE, NO_RESTAURANT, BRAND_NOT_EDITABLE, NO_COURIER_PROFILE
- 404: NOT_FOUND, USER_NOT_FOUND, RESTAURANT_NOT_FOUND, MENU_ITEM_NOT_FOUND, ADDRESS_NOT_FOUND, ORDER_NOT_FOUND, PLACE_NOT_FOUND,
  OFFER_NOT_FOUND, CANCEL_REQUEST_NOT_FOUND
- 409 (M9): NO_COURIER_NEARBY, VERSION_CONFLICT, CANCEL_REQUEST_CLOSED, CUSTOMER_WAIT_NOT_OVER
- 409: CONFLICT, CONSTRAINT_VIOLATION, REFERENCE_VIOLATION, EMAIL_TAKEN, REFRESH_IN_PROGRESS, RESTAURANT_ALREADY_CLAIMED,
  RESTAURANT_AUTO_PAUSED, RESTAURANT_UNAVAILABLE, RESTAURANT_CLOSED, ADDRESS_LIMIT, CART_EMPTY, CART_NO_ADDRESS,
  CART_OTHER_RESTAURANT, ITEM_UNAVAILABLE, PRICE_CHANGED, ORDER_NOT_PAYABLE, ORDER_NOT_CANCELLABLE,
  ORDER_STATUS_CHANGED, ACCEPT_WINDOW_OVER, POSITION_STALE, TOO_FAR_AWAY, OFFER_CLOSED (CONSTRAINT_VIOLATION is also what the DB transition guard gives, should a service ever slip)
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

## Done: M7 Dispatch and courier delivery (2026-11-23, API + 133 tests; D1 happy path passed 2026-11-23)
Scope (decisions A-K, 2026-11-22): S1-S5, T12, T13, simulator, happy path script. S6 no_courier, S9 second round and
missed-offer counting → M9; auto-offline → M8; T1 "fresh courier within 10 km" checkout guard → M9.
- courierService.ts: lockActiveCourier (users row FOR NO KEY UPDATE: the offer insert's FK takes KEY SHARE, so FOR UPDATE
  would deadlock), position upsert, availability. Going offline = commit offline, then release the pending offer in a
  second transaction (closeOfferAsDeclined 'went_offline') and kick dispatch.
- courierSearch.ts: findCourierCandidates = bounding box (BOX_M_PER_DEGREE 111 000, never smaller than the circle) +
  haversine <= SEARCH_RADIUS_M (10 km, constant; the 3/6/10 km rounds became one "nearest" query), fresh position,
  online, user active, no active order, no pending offer, not asked this round; nearest, then went_online_at; limit 5.
- dispatchService.ts: S1 claimOrderToStart, S2 claimOrderToSearch + tryOffer (locks the profile `online FOR NO KEY UPDATE
  SKIP LOCKED`, re-checks, INSERT ... ON CONFLICT DO NOTHING); no candidate → next_search_at backoff 2/5/10/30 s by the
  search age. dispatchDueOrders (timer), dispatchOrderNow and dispatchWaitingOrdersNear (kicks after commit, never throw).
- offerTimeout.ts: S4 expireTimedOutOffers (SKIP LOCKED, max 100). jobs/dispatchJobs.ts: 2 s timer (expiry, then dispatch),
  started in server.ts. Moves to the worker in M8.
- courierOfferService.ts: current offer, decline (S3), accept (S5: lock order user → order → offer; overdue pending → expired + 409).
- courierOrderService.ts: current order, T12 pickup, T13 deliver (proximity on the stored position, queuePaymentCapture,
  resolves incidents, frees the courier → dispatchWaitingOrdersNear). orderTransition.ts: courier scope
  (courier_id = me OR an accepted/withdrawn offer of mine) + assertAssignedCourier. routeService.getRouteOrNull (2.5 s cap).
  utils/geo.ts distanceMeters, utils/deliveryEta.ts (bike 1.5, scooter 1.2, car 1.0 × OSRM car duration; 25 km/h fallback).
- Scripts (`scripts/`, typechecked with src, never imported by it): lib/apiClient (re-login on ACCESS_TOKEN_EXPIRED),
  lib/movement (polyline decode, moveAlong, randomPointNear), lib/courierBot.
  `npm run simulate:courier` (fleet of 2-6 seed couriers, --couriers N, --restaurant, --email, --answer, --speedup, --once).
  `npm run happy-path` (-- --runs 5 for D1): needs the API + `stripe listen`; new customer per run (signup limit 5/h),
  activation token inserted in the dev DB, pays with pm_card_visa via the secret key, local API only.
- Seed: courier1..courier6 (bike, scooter, car, bike, scooter, car).
- Tests: tests/integration/dispatch/* (112, helpers in tests/helpers/dispatch.ts) + tests/unit/courierMath.test.ts (21):
  courierAvailability (36: access per route incl. NO_COURIER_PROFILE/ACCOUNT_NOT_ACTIVE, position upsert + validation,
  online/offline, offline releases the offer), courierSearch (14: nearest, ties, every exclusion, 9.9 vs 10.1 km, box vs
  circle), dispatch (16: S1, S2, backoff 2/5/10/30, kicks, S4), offers (16: no customer data, decline, accept, late accept,
  withdrawn), pickupDeliver (19: T12/T13, proximity, ETA per vehicle + fallback, capture key, lost order 409 vs 404),
  races (9, each run 8 times: accept vs expiry, accept vs T11, two passes, decline vs expiry, offline vs dispatch/accept,
  double accept, double deliver, pickup vs T11), dispatchJobs (2: the real 2 s timer with only setInterval faked).
  No src bugs found. resetAccountTables now also deletes order_cancel_requests, courier_positions and courier_profiles.
  Time travel: passOfferDeadline also moves offered_at back (CHECK order_offers_expiry_after_offer).

## Done: M7b Customer live courier map (2026-11-23, API + web + 26 tests; browser DoD check pending)
Decisions A-H: two endpoints (tracking poll + route per leg), legs, courier = first name + vehicle, stale flag, own order
only (404), no migration and no new error codes, react-leaflet@5, OrderPage polls every non-final status.
- trackingService.ts: getOrderTracking (one SELECT, LEFT JOINs users/courier_profiles/courier_positions, status filter in
  the ON so a finished order still returns its row), getOrderRoute (reuses getOrderTracking, then getRouteOrNull).
  Handlers in orderController, routes in orderRoutes (customer router, validateIdParam).
- Web: see bitefetch-web/CLAUDE.md (CourierMap, LiveTracking on OrderPage).
- Tests: tests/integration/tracking/* (helpers in tests/helpers/tracking.ts: getTracking, getRoute, fetchedUrls).
  tracking (15): 401/403/400/404, no courier when placed or accepted without one, exact courier keys (no leaks),
  legs per status, T11 and delivered hide the courier (courier_id still set), position null / fresh / 40 s stale /
  the boundary, headingDeg. route (11): same access cases, no OSRM call without a leg or a position, the OSRM URL
  from the courier's current position, to_customer from the checkout cache, OSRM 500 → null, a 3 s OSRM → null at 2.5 s
  (the slow test waits for the late answer so it cannot leak into the next test). No src bugs found.

## Done: M8 Worker service and sweepers (2026-11-23, code + 43 tests)
Decisions A-I: separate process, one job runner, graceful shutdown, health log, reconciliation, auto-offline,
settings cache, hourly retention. S6 no_courier stays in M9. Stayed TypeScript (the worker reuses the services).
- The API (server.ts) starts NO timers any more. `npm run worker` → src/worker.ts: SELECT 1 (fail fast), starts every
  job in src/jobs/jobList.ts, health log every 60 s (warn "Job looks stuck" when no pass finished for 5 intervals, min
  1 min), SIGINT/SIGTERM → stop all jobs, wait ≤ 10 s, pool.end(), exit 0 (exit 1 on timeout).
- jobs/jobRunner.ts startJob({name, everyMs, run}): setTimeout chain (next pass planned in finally, so passes never
  overlap; everyMs counts from the END of a pass), first pass at once (schedule(0)), stats per job, stop() waits for
  the running pass. jobs/paymentJobs.ts and jobs/dispatchJobs.ts were deleted.
- jobList.ts: payment-expiry 5 s, accept-timeout 5 s, payment-outbox 5 s, dispatch 2 s (S4 then S1/S2),
  payment-reconciliation 60 s, courier-auto-offline 15 s, retention 1 h.
- settingsService: whole platform_settings table cached 10 s per process (lazy reload, one shared in-flight load,
  a failed load is not cached); clearSettingsCache() (called in tests/helpers/setupDb.ts beforeEach).
- paymentAuthorization.ts placeAuthorizedOrder(client, order, pi, acceptWindowS): T3 rules moved out of
  webhookService.onAuthorized (late → void, not pending → skip, amount ≠ total → refuse, else placed + outbox
  order.placed); returns the outcome. The caller locks the order and reads the setting before the lock.
- paymentReconciliation.ts reconcilePendingPayments: ≤ 20 pending_payment orders with a PI older than
  reconcile_after_s (no lock), paymentIntents.retrieve OUTSIDE any transaction (break on a Stripe error), then per
  order a short transaction (FOR UPDATE SKIP LOCKED, id AND PI match): requires_capture → placeAuthorizedOrder,
  canceled → expireOrder('payment_window'). Actor system:reconcile.
- courierAutoOffline.ts setSilentCouriersOffline: ≤ 50 online active couriers with no position for
  courier_no_position_offline_s (120) and NO active order (design note 17); per courier: users row FOR NO KEY UPDATE
  SKIP LOCKED, UPDATE ... offline 'no_position' with the same SILENT_AND_FREE check under the lock, then
  courierService.releasePendingOffer (extracted from goOffline: give back the pending offer + dispatchOrderNow).
  Actor system:auto-offline. Gotcha: an unused $n parameter fails in Postgres ("could not determine data type").
- retention.ts runRetention: SELECT * FROM run_retention() (SQL rules: outbox 7 d, stripe_events 30 d, tokens,
  offers 12 months, expired caches, stale carts, audit 24 months, A4 never-activated users 7 d; 5000 rows per table
  per call; drops order_status_history partitions > 12 months and creates the next 3).
- Tests (43, helpers in tests/helpers/worker.ts: setSetting/restoreSettings because platform_settings is NOT reset
  between tests, ageOrder): tests/unit/jobRunner (7, jest fake timers incl. Date; afterEach must advance fake time
  while stop() waits for a slow pass), tests/integration/worker/: settingsCache (6), reconciliation (11: placed with
  actor system:reconcile, canceled → expired + cart + one void, young/in-progress untouched, Stripe down stops the
  pass, webhook + reconcile in parallel = one T3, max 20 oldest first), autoOffline (10: silent/no row/young,
  offline or suspended untouched, active delivery in 3 statuses untouched, offer declined went_offline and the next
  courier offered in the same pass, two passes = one offline), retention (3), outboxLease (3 = the DoD: worker died
  before / after the Stripe call, two workers after the lease), jobList (1); dispatch/dispatchJobs rewritten (2, real
  timers, the 'dispatch' entry of JOBS). Also re-ran payments + dispatch + restaurantOrders: 240 green.
  No src bugs found by the tests (the unused-$1 bug in auto-offline was caught and fixed before them).

## Done: M9 Unhappy paths and incidents (2026-11-24, code + 110 tests; written by Claude Code at the developer's request, not piece by piece)
Decisions: admin ACTIONS on one order now (T14 decide, T15, T16, T17, S7, S8 + GET /admin/orders/:id), the admin lists /
queues stay in M11; the admin's version = orders.version (T14: the request's own version); audit actor admin:{id}.
- Migration 1794200000000: platform setting checkout_courier_check (1). Run `npm run migrate:up` on the dev DB.
  With 1, a browser checkout needs a courier online (simulator), else set it to 0 in the dev DB.
- orderCancellation.ts cancelLockedOrder: the one "→ cancelled" for T5/T9/T11/T14/T15/T18 (courier released unless picked
  up, pending offer withdrawn, pending cancel request superseded, void, every open incident resolved). Returns the freed
  courier → dispatchWaitingOrdersNear after the commit. orderTransition: scope { anyOrder: true }, dispatchState in
  LockedOrder, assertVersion (VERSION_CONFLICT), ACTIVE_STATUSES.
- incidents.ts openOrderIncident (ON CONFLICT on the open-per-type index) / resolveOrderIncidents (types or 'all').
- orderCancelService: T18 (no_courier + courier_id NULL → cancel_reason no_courier), optional note → cancel_note.
- ownerOrderService: T7 unavailableItemIds (restaurant_item_availability, only items of the order) + cart restore
  (also T8 in acceptTimeout); T11 via cancelLockedOrder; requestOrderCancellation (T14 step 1).
- Missed offers (flow 3 Q2): offerTimeout S4 is one statement (expire + consecutive_missed_offers + 1, at
  MISSED_OFFERS_LIMIT 2 an online courier goes offline missed_offers); decline (S3) and accept (S5) reset to 0.
- dispatchService: S6 markNoCourierOrders (dispatch job: S4 → S6 → S1/S2; incident no_courier), S9 startSecondRound
  (round 1, searching, second_round_after_s, no candidate at all → round 2 at once; deadline not moved; at most once).
  courierSearch + dispatchWaitingOrdersNear: a courier whose offer for THIS order expired or was withdrawn (S8) is never
  asked again for it, in any round (so round 2 re-asks only decliners). hasCourierNear for the T1 guard.
- incidentSweeps.ts (job incident-sweep, 30 s): kitchen_late (accepted, estimated_ready_at + 600 s) and delivery_overdue
  (picked_up, estimated_delivery_at + 1800 s); one statement each, FOR UPDATE OF o SKIP LOCKED (re-checks the status, so a
  ready/delivered order never gets one), once per order (not reopened after the admin resolved it).
- courierOrderService: markPickedUp / markDelivered shared by T12/T16 and T13/T17 (deliver now resolves every open
  incident but capture_failed); reportProblem (R5).
- adminOrderService.ts + adminRoutes (requireAuth, requireRole('admin'), requireLiveSession) + adminSchema.
- scripts/happyPath.ts: the courier goes online BEFORE the checkout (T1 guard) and the run waits until GET /courier says online.
  Not re-run (needs the API): run `npm run happy-path` once.
- Tests: tests/integration/unhappy/* (110, helpers in tests/helpers/unhappy.ts; createAdmin logs in for real because of
  requireLiveSession): one file per diagram page: restaurantRejects (9), courierDeclines (9), offerTimesOut (9),
  nobodyAccepts (20: S6, kick from no_courier, S9 ×4, S7, two admins, T15, T18 + T18 vs accept ×6), customerCancels (10),
  paymentFails (8); plus incidents (15), adminActions (23), checkoutCourierGuard (7). setupDb sets checkout_courier_check 0.
  Changed for the new behaviour: customerCancel (details has dispatchState), jobList (incident-sweep), dispatch/races
  (accept vs expiry got a 20 s timeout: about 5 s already in M8, flaky at Jest's default 5 s).
  Re-ran unhappy + restaurantOrders + dispatch + payments + worker + orders + tracking + unit: 530 green. No src bugs found.

## Next
Done 2026-11-24: migrate:up on the dev DB, happy-path passed with the changed script, full `npm test` green (D2).
An unhappy-paths script against real Stripe was considered and skipped (flows checked by hand in M5, covered by the
tests; the Playwright e2e in M13 covers them through the UI). Ideas #2 robot couriers and #3 "use my location" are in
docs/design/notes/future-ideas.md.
1. Tag d2-unhappy-paths (the developer).
2. Web for M6 (owner board): the developer builds it. It unblocks step 4.
3. Web for M9: OrderPage shows Cancel while dispatchState = no_courier (customer cancel when no courier is found) and
   the cancel note; checkout shows NO_COURIER_NEARBY.
4. Check the M7b DoD in the browser with `npm run simulate:courier` (the developer). Dev needs `npm run worker` too.
5. D1 note "harder than planned" in the tracker (tag d1-happy-path is on 575e4e4, local only).
6. M9b Robot couriers, API part (tracker; design in future-ideas.md #2), agreed 2026-11-24. Then M10 (realtime) or M11 (admin lists).
Known gaps left on purpose: live updates instead of polling (M10); no socket events for M9 (offer.closed, incident.opened, ...: M10);
owner actions do not re-check users.status (stateless access token, like the other owner routes); T10 ready does not kick
dispatch (the 2 s timer picks it up); the S4 sweep does not kick dispatch either (the order's next_search_at already
equals the offer's expires_at, so the next tick searches it); admin retry-capture (flow 6) is M11 (see Parked).

## Parked
- Admin approve (M11) must copy openingHours from application details into the restaurant.
- Retention jobs for osm_search_cache / route_cache (M13).
- M11 retry-capture trap: the Stripe key is `order:{id}:capture:{attempt}` with the attempt from the OUTBOX ROW, so a new
  outbox row for a manual retry restarts at :1 and Stripe replays the old (failed) result. The retry must continue from
  orders.capture_attempts (:4, ...).
- browseService.listNearbyRestaurants uses 111.32 km per degree for its box (about 11 m too small at 10 km); courierSearch
  uses 111 000 m on purpose. Harmless, align when touched.
- Dockerfile CMD is `node src/server.js`; the build output is `dist/src/server.js` (fix in M14).
- Admin fleet map (all online couriers): an idea, docs/design/notes/future-ideas.md #1.
- Web: owner/courier/admin home page still shows the customer "Order food" section; replace with role dashboards (M6/M12).