import express, { Router } from 'express';
import { stripeWebhookHandler } from '../controllers/webhookController';

const router = Router();

// Raw bytes, not parsed JSON: the signature is computed over the exact body Stripe sent.
router.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhookHandler);

export { router as webhookRoutes };