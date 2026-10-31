import { Router } from 'express';
import { z } from 'zod';
import * as ctrl from '../controllers/integrationsController.js';
import { validate } from '../middleware/validate.js';
import { CONNECTION_STATUSES } from '../repositories/integrationConnectionsRepository.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const provider = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Unknown provider');
const providerParams = z.object({ provider });
const resourceParams = z.object({ id, resourceId: id });

const listQuery = z.object({ provider: provider.optional(), status: z.enum(CONNECTION_STATUSES).optional() }).strict();

// What the provider sent back through the browser. The state is checked server-side; params are
// checked by the connector (e.g. GitHub: installation_id, setup_action).
const callbackSchema = z
  .object({
    state: z.string().min(20).max(200),
    params: z
      .record(z.string().max(64), z.union([z.string().max(4096), z.number()]))
      .refine((p) => Object.keys(p).length <= 20, 'Too many parameters')
      .default({}),
  })
  .strict();

const updateSchema = z
  .object({ isEnabled: z.boolean(), displayName: z.string().trim().min(1).max(200) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const resourceUpdateSchema = z
  .object({ isEnabled: z.boolean().optional(), projectId: optionalNullable(id) })
  .strict()
  .refine((v) => v.isEnabled !== undefined || v.projectId !== undefined, 'Provide isEnabled or projectId');

const disconnectSchema = z.object({ uninstall: z.boolean().default(false) }).strict();

const deliveriesQuery = z
  .object({
    status: z.enum(['received', 'processing', 'processed', 'ignored', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const identitiesQuery = z
  .object({ provider: provider.optional(), unmatched: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') })
  .strict();
const identityMatchSchema = z.object({ userId: optionalNullable(id).transform((v) => v ?? null) }).strict();

// Mounted at /integrations behind requireAuth + requireRole('admin').
export const integrationsRouter = Router();

integrationsRouter.get('/providers', ctrl.listProviders);
integrationsRouter.get('/', validate({ query: listQuery }), ctrl.list);
integrationsRouter.post('/:provider/connect', validate({ params: providerParams }), ctrl.startConnect);
integrationsRouter.post('/:provider/callback', validate({ params: providerParams, body: callbackSchema }), ctrl.completeConnect);

integrationsRouter.post('/webhook-deliveries/:id/replay', validate({ params: idParams }), ctrl.replayDelivery);
// People in connected applications, matched to WorkAgent users (before '/:id', which would capture them).
integrationsRouter.get('/identities', validate({ query: identitiesQuery }), ctrl.listIdentities);
integrationsRouter.patch('/identities/:id', validate({ params: idParams, body: identityMatchSchema }), ctrl.matchIdentity);
integrationsRouter.get('/:id', validate({ params: idParams }), ctrl.get);
integrationsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), ctrl.update);
integrationsRouter.post('/:id/sync', validate({ params: idParams }), ctrl.syncNow);
integrationsRouter.post('/:id/disconnect', validate({ params: idParams, body: disconnectSchema }), ctrl.disconnect);
integrationsRouter.get('/:id/resources', validate({ params: idParams }), ctrl.listResources);
integrationsRouter.post('/:id/resources/refresh', validate({ params: idParams }), ctrl.refreshResources);
integrationsRouter.patch('/:id/resources/:resourceId', validate({ params: resourceParams, body: resourceUpdateSchema }), ctrl.updateResource);
integrationsRouter.get('/:id/webhook-deliveries', validate({ params: idParams, query: deliveriesQuery }), ctrl.listDeliveries);
