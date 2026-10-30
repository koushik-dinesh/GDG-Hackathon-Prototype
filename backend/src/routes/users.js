import { Router } from 'express';
import { z } from 'zod';
import * as usersCtrl from '../controllers/usersController.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { email, id, idParams, personName, role } from '../utils/validation.js';

const createSchema = z.object({
  email,
  fullName: personName,
  role: role.default('employee'),
});

const updateSchema = z
  .object({ email, fullName: personName, role, isActive: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listQuery = z.object({
  includeInactive: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

const aliasSchema = z.object({ alias: z.string().trim().min(1, 'Required').max(200) });
const aliasParams = z.object({ id, aliasId: id });

// Mounted behind requireAuth + requireRole('admin').
export const usersRouter = Router();

usersRouter.get('/', validate({ query: listQuery }), usersCtrl.list);
usersRouter.post('/', validate({ body: createSchema }), usersCtrl.create);
usersRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), usersCtrl.update);
usersRouter.delete('/:id', validate({ params: idParams }), usersCtrl.deactivate);

usersRouter.get('/:id/aliases', validate({ params: idParams }), usersCtrl.listAliases);
usersRouter.post('/:id/aliases', validate({ params: idParams, body: aliasSchema }), usersCtrl.addAlias);
usersRouter.delete('/:id/aliases/:aliasId', validate({ params: aliasParams }), usersCtrl.removeAlias);

// Invitations (Phase 2). Sending is limited per admin because each call sends an email.
const inviteLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `invite:${req.user.id}` });
usersRouter.get('/:id/invitations', validate({ params: idParams }), usersCtrl.listInvitations);
usersRouter.post('/:id/invitations', inviteLimiter, validate({ params: idParams }), usersCtrl.invite);
usersRouter.post('/:id/invitations/revoke', validate({ params: idParams }), usersCtrl.revokeInvite);
