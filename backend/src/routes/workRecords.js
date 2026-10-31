import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/workRecordsController.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { ACTIVITY_TYPE_NAMES } from '../services/activities/types.js';
import { LINK_TYPES, STATUS_CATEGORIES } from '../services/integrations/envelopes.js';
import { ENDPOINT_TYPES } from '../services/integrations/links.js';
import { SEARCH_TYPES } from '../services/search.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const limit = z.coerce.number().int().min(1).max(100).default(50);
const before = z.string().max(200).optional();
const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const provider = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional();
const recordType = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).optional();
// Repeated (?activityType=a&activityType=b) or comma-separated.
const list = (schema) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean)))
    .pipe(z.array(schema).max(30).optional());
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO date or date-time').transform((v) => new Date(v)).optional();
const scope = {
  projectId: id.optional(),
  // Admins only: records/activities that are not in any project.
  unassigned: bool,
};

const recordsQuery = z
  .object({ ...scope, recordType, statusCategory: z.enum(STATUS_CATEGORIES).optional(), provider, includeDeleted: bool, q: z.string().trim().min(1).max(100).optional(), before, limit })
  .strict();

const activitiesQuery = z
  .object({
    ...scope,
    userId: id.optional(),
    provider,
    activityType: list(z.enum(ACTIVITY_TYPE_NAMES)),
    from: isoDateTime,
    to: isoDateTime,
    recordId: id.optional(),
    entityType: z.enum(['meeting', 'action_item', 'project']).optional(),
    entityId: id.optional(),
    subjectType: recordType,
    status: z.enum(STATUS_CATEGORIES).optional(),
    before,
    limit,
  })
  .strict()
  .refine((v) => !v.entityType === !v.entityId, 'entityType and entityId go together');

const endpoint = z.object({ type: z.enum(Object.keys(ENDPOINT_TYPES)), id }).strict();
const linkSchema = z.object({ from: endpoint, to: endpoint, linkType: z.enum(LINK_TYPES) }).strict();
const reviewSchema = z.object({ status: z.enum(['confirmed', 'rejected']) }).strict();
const linksQuery = z
  .object({ type: z.enum(Object.keys(ENDPOINT_TYPES)).optional(), id: id.optional(), status: z.enum(['suggested']).optional() })
  .strict()
  .refine((v) => !v.type === !v.id, 'type and id go together');
const recordProjectSchema = z.object({ projectId: optionalNullable(id).transform((v) => v ?? null) }).strict();

const searchQuery = z
  .object({
    q: z.string().trim().min(1, 'Type something to search for').max(100),
    types: list(z.enum(SEARCH_TYPES)),
    projectId: id.optional(),
    recordType,
    provider,
    includeDeleted: bool,
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

// Mounted behind requireAuth. Reads are permission-checked per project/task in the services;
// relationship changes are checked there too (admins; managers within projects they manage).
export const externalRecordsRouter = Router();
externalRecordsRouter.get('/', validate({ query: recordsQuery }), ctrl.listRecords);
externalRecordsRouter.get('/:id', validate({ params: idParams }), ctrl.getRecord);
externalRecordsRouter.put('/:id/project', requireRole('admin'), validate({ params: idParams, body: recordProjectSchema }), ctrl.setRecordProject);

export const activitiesRouter = Router();
activitiesRouter.get('/', validate({ query: activitiesQuery }), ctrl.listActivities);
activitiesRouter.get('/types', ctrl.listActivityTypes);

export const recordLinksRouter = Router();
recordLinksRouter.get('/', validate({ query: linksQuery }), ctrl.listRecordLinks);
recordLinksRouter.post('/', validate({ body: linkSchema }), ctrl.createRecordLink);
recordLinksRouter.patch('/:id', validate({ params: idParams, body: reviewSchema }), ctrl.reviewRecordLink);

export const searchRouter = Router();
searchRouter.get('/', validate({ query: searchQuery }), ctrl.search);
