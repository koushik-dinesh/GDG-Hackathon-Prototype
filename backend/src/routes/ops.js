import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import * as ops from '../services/ops.js';
import { id, idParams } from '../utils/validation.js';

const limit = z.coerce.number().int().min(1).max(200).default(50);
const date = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO date or date-time')
  .transform((v) => new Date(v))
  .optional();

const jobsQuery = z
  .object({ status: z.enum(['pending', 'running', 'succeeded', 'failed', 'dead']).optional(), type: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/).optional(), before: id.optional(), limit })
  .strict();
const auditQuery = z
  .object({
    // An exact action, or a prefix ending in "." (e.g. "integration.").
    action: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/).optional(),
    entityType: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
    entityId: id.optional(),
    actorUserId: id.optional(),
    from: date,
    to: date,
    before: id.optional(),
    limit,
  })
  .strict();
const emailsQuery = z.object({ status: z.enum(['queued', 'sending', 'sent', 'failed', 'retry']).optional(), before: id.optional(), limit }).strict();
const runsQuery = z.object({ status: z.enum(['running', 'succeeded', 'failed']).optional(), before: id.optional(), limit }).strict();

// Phase 8 operations center. Mounted at /ops behind requireAuth + requireRole('admin').
export const opsRouter = Router();

opsRouter.get('/summary', async (req, res) => res.json(await ops.summary()));
opsRouter.get('/jobs', validate({ query: jobsQuery }), async (req, res) => res.json(await ops.listJobs(req.query)));
opsRouter.post('/jobs/:id/retry', validate({ params: idParams }), async (req, res) => res.json({ job: await ops.retryJob(req.params.id, { actor: req.user, ip: req.ip }) }));
opsRouter.post('/jobs/:id/cancel', validate({ params: idParams }), async (req, res) => res.json({ job: await ops.cancelJob(req.params.id, { actor: req.user, ip: req.ip }) }));
opsRouter.get('/audit', validate({ query: auditQuery }), async (req, res) => res.json(await ops.listAudit(req.query)));
opsRouter.get('/audit/actions', async (req, res) => res.json({ actions: await ops.listActions() }));
opsRouter.get('/emails', validate({ query: emailsQuery }), async (req, res) => res.json(await ops.listEmails(req.query)));
opsRouter.get('/ai-runs', validate({ query: runsQuery }), async (req, res) => res.json(await ops.listAiRuns(req.query)));
