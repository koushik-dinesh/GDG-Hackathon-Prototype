import { Router } from 'express';
import { z } from 'zod';
import * as teamsCtrl from '../controllers/teamsController.js';
import { validate } from '../middleware/validate.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const name = z.string().trim().min(1, 'Required').max(200);
const description = optionalNullable(z.string().trim().max(5000));

const createSchema = z
  .object({ name, description, leadUserId: optionalNullable(id), memberIds: z.array(id).max(500).optional() })
  .strict();

const updateSchema = z
  .object({ name, description, leadUserId: optionalNullable(id) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const membersSchema = z.object({ userIds: z.array(id).min(1, 'Choose at least one person').max(500) }).strict();
const memberParams = z.object({ id, userId: id });

// Mounted at /teams behind requireAuth (any role); permissions are checked in the controller.
export const teamsRouter = Router();

teamsRouter.get('/', teamsCtrl.list);
teamsRouter.post('/', validate({ body: createSchema }), teamsCtrl.create);
teamsRouter.get('/:id', validate({ params: idParams }), teamsCtrl.get);
teamsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), teamsCtrl.update);
teamsRouter.post('/:id/members', validate({ params: idParams, body: membersSchema }), teamsCtrl.addMembers);
teamsRouter.delete('/:id/members/:userId', validate({ params: memberParams }), teamsCtrl.removeMember);
