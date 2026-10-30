import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { validate } from '../middleware/validate.js';
import { webhookService } from '../services/integrations/webhooks.js';

// The global JSON parser skips this path (app.js) so the signature can be checked over the raw body.
export const WEBHOOK_PATH = /^\/api\/v1\/webhooks\/[^/]+\/?$/;

const params = z.object({ provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) });

// Public: providers call it. Mounted at /webhooks with no session; trust comes from the signature.
export const webhooksRouter = Router();

webhooksRouter.post(
  '/:provider',
  express.raw({ type: () => true, limit: config.integrations.webhookMaxBytes }),
  validate({ params }),
  async (req, res) => {
    const result = await webhookService.receive({
      providerId: req.params.provider,
      headers: req.headers,
      rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    // 202 for new, duplicate and re-queued deliveries alike: the provider only needs to know it arrived.
    res.status(202).json({ received: true, duplicate: result.status === 'duplicate' });
  },
);
