import { Router } from 'express';
import { z } from 'zod';
import * as itemsCtrl from '../controllers/actionItemsController.js';
import { validate } from '../middleware/validate.js';
import { FLAGS } from '../services/ai/validator.js';
import { PRIORITIES } from '../services/ai/schema.js';
import { isValidIsoDate } from '../utils/dates.js';
import { id, idParams, optionalNullable } from '../utils/validation.js';

const title = z.string().trim().min(1, 'Required').max(255);
const description = optionalNullable(z.string().trim().max(5000));
const dueDate = optionalNullable(z.string().refine(isValidIsoDate, 'Use a valid date (YYYY-MM-DD)'));
const assigneeUserId = optionalNullable(id);

export const manualItemSchema = z
  .object({ title, description, priority: z.enum(PRIORITIES).default('medium'), assigneeUserId, dueDate, projectId: optionalNullable(id) })
  .strict();

// Project association is separate from review content, so it can change in any review state.
const projectSchema = z.object({ projectId: z.preprocess((v) => (v === '' ? null : v), id.nullable()) }).strict();

const updateSchema = z
  .object({
    title,
    description,
    priority: z.enum(PRIORITIES),
    assigneeUserId,
    dueDate,
    resolveFlags: z.array(z.enum(Object.keys(FLAGS))).max(30),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const rejectSchema = z.object({ reason: optionalNullable(z.string().trim().max(500)) }).strict();

// Mounted at /action-items behind requireAuth + requireRole('admin').
export const actionItemsRouter = Router();

actionItemsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), itemsCtrl.update);
actionItemsRouter.post('/:id/approve', validate({ params: idParams }), itemsCtrl.approve);
actionItemsRouter.post('/:id/reject', validate({ params: idParams, body: rejectSchema }), itemsCtrl.reject);
actionItemsRouter.post('/:id/reopen', validate({ params: idParams }), itemsCtrl.reopen);
actionItemsRouter.put('/:id/project', validate({ params: idParams, body: projectSchema }), itemsCtrl.setProject);
