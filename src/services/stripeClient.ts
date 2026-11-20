import Stripe from 'stripe';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

const secretKey = requireEnv('STRIPE_SECRET_KEY');

// Safety net: outside production, refuse anything that is not a test key.
if (process.env.NODE_ENV !== 'production' && !secretKey.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a test key (sk_test_...) outside production');
}

export const STRIPE_WEBHOOK_SECRET = requireEnv('STRIPE_WEBHOOK_SECRET');

export const stripe = new Stripe(secretKey, {
    maxNetworkRetries: 2, // if the connection fails or Stripe answers with a 5xx (or 409 / 429), try again at most 2 more times (3 calls in total)
    timeout: 10_000,      // 10 s instead of the 80 s default: a hung Stripe call must not hold a request
});