import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { buildInsights } from '../services/insights.js';
import { id } from '../utils/validation.js';

const date = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO date or date-time')
  .transform((v) => new Date(v))
  .optional();

const insightsQuery = z
  .object({ projectId: id.optional(), teamId: id.optional(), from: date, to: date })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '"from" must be before "to"', path: ['from'] })
  .refine((q) => !q.from || !q.to || q.to - q.from <= 366 * 86_400_000, { message: 'The period can be at most a year', path: ['to'] });

// Phase 7: evidence-backed insights for what the signed-in person may see (services/insights.js).
export const insightsRouter = Router();

insightsRouter.get('/', validate({ query: insightsQuery }), async (req, res) => {
  res.json(await buildInsights(req.user, req.query));
});
