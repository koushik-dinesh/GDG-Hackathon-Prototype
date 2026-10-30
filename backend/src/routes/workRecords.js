import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/workRecordsController.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ENDPOINT_TYPES } from '../services/integrations/links.js';
import { LINK_TYPES, STATUS_CATEGORIES } from '../services/integrations/envelopes.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const limit = z.coerce.number().int().min(1).max(100).default(50);
const before = z.string().max(200).optional();
const scope = {
  projectId: id.optional(),
  // Admins only: records/activities that are not in any project.
  unassigned: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
};

const recordsQuery = z
  .object({
    ...scope,
    recordType: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).optional(),
    statusCategory: z.enum(STATUS_CATEGORIES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    before,
    limit,
  })
  .strict();
const activitiesQuery = z.object({ ...scope, before, limit }).strict();

const endpoint = z.object({ type: z.enum(Object.keys(ENDPOINT_TYPES)), id }).strict();
const linkSchema = z.object({ from: endpoint, to: endpoint, linkType: z.enum(LINK_TYPES) }).strict();
const reviewSchema = z.object({ status: z.enum(['confirmed', 'rejected']) }).strict();
const recordProjectSchema = z.object({ projectId: optionalNullable(id).transform((v) => v ?? null) }).strict();

const adminOnly = requireRole('admin');

// Mounted behind requireAuth at /external-records, /activities and /record-links. Reads are
// permission-checked per project in the controller; changes are admin-only.
export const externalRecordsRouter = Router();
externalRecordsRouter.get('/', validate({ query: recordsQuery }), ctrl.listRecords);
externalRecordsRouter.get('/:id', validate({ params: idParams }), ctrl.getRecord);
externalRecordsRouter.put('/:id/project', adminOnly, validate({ params: idParams, body: recordProjectSchema }), ctrl.setRecordProject);

export const activitiesRouter = Router();
activitiesRouter.get('/', validate({ query: activitiesQuery }), ctrl.listActivities);

export const recordLinksRouter = Router();
recordLinksRouter.post('/', adminOnly, validate({ body: linkSchema }), ctrl.createRecordLink);
recordLinksRouter.patch('/:id', adminOnly, validate({ params: idParams, body: reviewSchema }), ctrl.reviewRecordLink);
