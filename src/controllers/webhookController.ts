import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { AppError } from '../errors/AppError';
import { stripe, STRIPE_WEBHOOK_SECRET } from '../services/stripeClient';
import { handleStripeEvent } from '../services/webhookService';

async function stripeWebhookHandler(req: Request, res: Response) {
    const signature = req.header('Stripe-Signature');
    if (!signature || !Buffer.isBuffer(req.body)) {
        throw new AppError(400, 'INVALID_SIGNATURE', 'Missing Stripe signature or body');
    }

    let event: Stripe.Event;
    try{
        // Recomputes the signature from the RAW bytes + whsec_ and checks the timestamp (5 min tolerance).
        event =  stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
    }catch {
        throw new AppError(400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    }

    const result = await handleStripeEvent(event);
    res.json({ received: true, duplicate: result === 'duplicate' });
}

export { stripeWebhookHandler };