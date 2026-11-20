import Stripe from 'stripe';

// Tests never talk to Stripe. tests/helpers/stripeMock.ts replaces src/services/stripeClient with
// `fakeStripeModule`: an in-memory PaymentIntents API that behaves like Stripe for what we use
// (idempotency keys, "unexpected state" errors), plus the REAL webhook helpers (pure crypto, no network).

const WEBHOOK_SECRET = 'whsec_test_bitefetch';

// Only used for stripe.webhooks (constructEvent, generateTestHeaderString). Never makes a request.
const real = new Stripe('sk_test_never_used');

type Method = 'create' | 'retrieve' | 'cancel' | 'capture';

interface FakePaymentIntent {
    id: string;
    object: 'payment_intent';
    amount: number;
    amount_capturable: number;
    currency: string;
    status: Stripe.PaymentIntent.Status;
    capture_method: 'manual' | 'automatic';
    client_secret: string;
    metadata: Record<string, string>;
    last_payment_error: { message: string } | null;
}

interface Call {
    method: Method;
    id?: string;
    idempotencyKey?: string;
}

const state = {
    intents: new Map<string, FakePaymentIntent>(),
    byKey: new Map<string, string>(),       // idempotency key → PaymentIntent id (create only)
    calls: [] as Call[],
    failures: [] as { method: Method; error: Error }[],
    seq: 0,
};

const copy = (pi: FakePaymentIntent): FakePaymentIntent => JSON.parse(JSON.stringify(pi));

function invalidRequest(code: string, message: string): Error {
    return new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code, message });
}

// A queued failure for this method (see failNext) is thrown once.
function maybeFail(method: Method): void {
    const index = state.failures.findIndex((f) => f.method === method);
    if (index >= 0) {
        const [failure] = state.failures.splice(index, 1);
        throw failure.error;
    }
}

function find(id: string): FakePaymentIntent {
    const pi = state.intents.get(id);
    if (!pi) throw invalidRequest('resource_missing', `No such payment_intent: '${id}'`);
    return pi;
}

const paymentIntents = {
    async create(
        params: { amount: number; currency: string; capture_method?: 'manual' | 'automatic'; metadata?: Record<string, string> },
        options?: { idempotencyKey?: string }
    ) {
        state.calls.push({ method: 'create', idempotencyKey: options?.idempotencyKey });
        maybeFail('create');
        // Same key → Stripe returns the PaymentIntent of the first call.
        const existingId = options?.idempotencyKey ? state.byKey.get(options.idempotencyKey) : undefined;
        if (existingId) return copy(find(existingId));

        const id = `pi_fake_${++state.seq}`;
        const pi: FakePaymentIntent = {
            id,
            object: 'payment_intent',
            amount: params.amount,
            amount_capturable: 0,
            currency: params.currency,
            status: 'requires_payment_method',
            capture_method: params.capture_method ?? 'automatic',
            client_secret: `${id}_secret_fake`,
            metadata: params.metadata ?? {},
            last_payment_error: null,
        };
        state.intents.set(id, pi);
        if (options?.idempotencyKey) state.byKey.set(options.idempotencyKey, id);
        return copy(pi);
    },

    async retrieve(id: string) {
        state.calls.push({ method: 'retrieve', id });
        maybeFail('retrieve');
        return copy(find(id));
    },

    async cancel(id: string, _params?: unknown, options?: { idempotencyKey?: string }) {
        state.calls.push({ method: 'cancel', id, idempotencyKey: options?.idempotencyKey });
        maybeFail('cancel');
        const pi = find(id);
        if (pi.status === 'canceled' || pi.status === 'succeeded') {
            throw invalidRequest('payment_intent_unexpected_state', `This PaymentIntent's status is ${pi.status}`);
        }
        pi.status = 'canceled';
        pi.amount_capturable = 0;
        return copy(pi);
    },

    async capture(id: string, _params?: unknown, options?: { idempotencyKey?: string }) {
        state.calls.push({ method: 'capture', id, idempotencyKey: options?.idempotencyKey });
        maybeFail('capture');
        const pi = find(id);
        if (pi.status !== 'requires_capture') {
            throw invalidRequest('payment_intent_unexpected_state', `This PaymentIntent's status is ${pi.status}`);
        }
        pi.status = 'succeeded';
        pi.amount_capturable = 0;
        return copy(pi);
    },
};

// What src/services/stripeClient exports, faked.
const fakeStripeModule = {
    stripe: { paymentIntents, webhooks: real.webhooks },
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

// Test controls: change a PaymentIntent the way the customer's browser + bank would.
const fakeStripe = {
    reset(): void {
        state.intents.clear();
        state.byKey.clear();
        state.calls.length = 0;
        state.failures.length = 0;
    },
    get(id: string): FakePaymentIntent {
        return copy(find(id));
    },
    // The card was accepted: the money is held (manual capture). Returns the PaymentIntent as the webhook carries it.
    authorize(id: string, amountCapturable?: number): FakePaymentIntent {
        const pi = find(id);
        pi.status = 'requires_capture';
        pi.amount_capturable = amountCapturable ?? pi.amount;
        pi.last_payment_error = null;
        return copy(pi);
    },
    // The bank declined: the PaymentIntent is usable again for another card.
    decline(id: string, message = 'Your card was declined.'): FakePaymentIntent {
        const pi = find(id);
        pi.status = 'requires_payment_method';
        pi.last_payment_error = { message };
        return copy(pi);
    },
    // Changes the status directly (e.g. canceled from the Dashboard).
    setStatus(id: string, status: Stripe.PaymentIntent.Status): void {
        find(id).status = status;
    },
    // The next call of `method` throws (default: a network error, like Stripe being down).
    failNext(method: Method, error: Error = new Stripe.errors.StripeConnectionError({ message: 'connection lost' })): void {
        state.failures.push({ method, error });
    },
    calls(method?: Method): Call[] {
        return state.calls.filter((c) => !method || c.method === method);
    },
};

export { fakeStripe, fakeStripeModule, WEBHOOK_SECRET };
export type { FakePaymentIntent };
