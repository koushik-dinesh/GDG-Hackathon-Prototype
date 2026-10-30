import { Router } from 'express';
import { z } from 'zod';
import * as projectsCtrl from '../controllers/projectsController.js';
import { validate } from '../middleware/validate.js';
import { PROJECT_STATUSES } from '../repositories/projectsRepository.js';
import { id, idParams, isoDate, optionalNullable } from '../utils/validation.js';

const name = z.string().trim().min(1, 'Required').max(200);
const description = optionalNullable(z.string().trim().max(5000));
const status = z.enum(PROJECT_STATUSES);

const createSchema = z
  .object({
    name,
    description,
    status: status.default('planning'),
    ownerUserId: id.optional(),
    startDate: optionalNullable(isoDate),
    targetDate: optionalNullable(isoDate),
    memberIds: z.array(id).max(200).optional(),
  })
  .strict();

const updateSchema = z
  .object({ name, description, status, ownerUserId: id, startDate: optionalNullable(isoDate), targetDate: optionalNullable(isoDate) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listQuery = z
  .object({
    status: status.optional(),
    includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    q: z.string().trim().max(100).optional(),
  })
  .strict();

const addMembersSchema = z
  .object({ userIds: z.array(id).max(200).optional(), teamId: id.optional() })
  .strict()
  .refine((v) => (v.userIds?.length ?? 0) > 0 || v.teamId, 'Provide userIds or teamId');

const memberParams = z.object({ id, userId: id });

// Mounted at /projects behind requireAuth (any role). Permissions are checked per project in the
// controller: admins see everything, others only projects they own or belong to.
export const projectsRouter = Router();

projectsRouter.get('/', validate({ query: listQuery }), projectsCtrl.list);
projectsRouter.post('/', validate({ body: createSchema }), projectsCtrl.create);
projectsRouter.get('/:id', validate({ params: idParams }), projectsCtrl.get);
projectsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), projectsCtrl.update);

projectsRouter.get('/:id/members', validate({ params: idParams }), projectsCtrl.listMembers);
projectsRouter.post('/:id/members', validate({ params: idParams, body: addMembersSchema }), projectsCtrl.addMembers);
projectsRouter.delete('/:id/members/:userId', validate({ params: memberParams }), projectsCtrl.removeMember);

projectsRouter.get('/:id/meetings', validate({ params: idParams }), projectsCtrl.listMeetings);
projectsRouter.get('/:id/tasks', validate({ params: idParams }), projectsCtrl.listTasks);
projectsRouter.get('/:id/activity', validate({ params: idParams }), projectsCtrl.activity);
