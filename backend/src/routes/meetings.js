import express, { Router } from 'express';
import { z } from 'zod';
import * as itemsCtrl from '../controllers/actionItemsController.js';
import * as botCtrl from '../controllers/botController.js';
import * as emailsCtrl from '../controllers/emailsController.js';
import * as extractionCtrl from '../controllers/extractionController.js';
import * as meetingsCtrl from '../controllers/meetingsController.js';
import * as transcriptsCtrl from '../controllers/transcriptsController.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { FORMATS } from '../services/transcripts/parser.js';
import { id, idParams, optionalNullable, pagination } from '../utils/validation.js';
import { manualItemSchema } from './actionItems.js';

const STATUSES = [
  'draft', 'bot_requested', 'bot_joining', 'in_progress', 'ended', 'transcript_ready',
  'extracting', 'review_pending', 'approved', 'emails_sent', 'failed',
];

const meetingUrl = z.string().trim().max(1024).pipe(z.url({ protocol: /^https?$/, message: 'Must be an http(s) URL' }));
const isoDateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const languageHint = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Use a language code such as "en" or "pt-BR"');
const participantIds = z.array(id).max(200);

const createSchema = z.object({
  title: z.string().trim().min(1, 'Required').max(255),
  meetingUrl,
  scheduledAt: optionalNullable(isoDateTime),
  languageHint: optionalNullable(languageHint),
  participantIds: participantIds.optional(),
  // Optional project (Phase 2); null/empty = no project.
  projectId: optionalNullable(id),
});

const updateSchema = createSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  q: z.string().trim().max(100).optional(),
  projectId: z.union([z.literal('none'), id]).optional(),
  ...pagination,
});

const uploadSchema = z.object({
  content: z.string().min(1, 'Transcript is empty'),
  format: z.enum(['auto', ...FORMATS]).default('auto'),
  filename: z.string().trim().min(1).max(255).optional(),
});

// Transcript uploads get a larger body limit than the app-wide 100 KB. The 2 MB content
// limit is enforced in the controller; this leaves room for JSON escaping.
export const TRANSCRIPT_UPLOAD_PATH = /^\/api\/v1\/meetings\/[^/]+\/transcript\/upload\/?$/;
const uploadJson = express.json({ limit: '5mb' });

// Mounted behind requireAuth + requireRole('admin').
export const meetingsRouter = Router();

meetingsRouter.get('/', validate({ query: listQuery }), meetingsCtrl.list);
meetingsRouter.post('/', validate({ body: createSchema }), meetingsCtrl.create);
meetingsRouter.get('/:id', validate({ params: idParams }), meetingsCtrl.get);
meetingsRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), meetingsCtrl.update);

meetingsRouter.get('/:id/transcript', validate({ params: idParams }), transcriptsCtrl.get);

// AI extraction: queues a background job; the duplicate guard is in the controller.
const extractLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `extract:${req.user.id}` });
meetingsRouter.post('/:id/extract', extractLimiter, validate({ params: idParams }), extractionCtrl.extract);
meetingsRouter.get('/:id/action-items', validate({ params: idParams }), extractionCtrl.listActionItems);

// Review (Phase 4): manual items and finishing the review.
meetingsRouter.post('/:id/action-items', validate({ params: idParams, body: manualItemSchema }), itemsCtrl.createManual);
meetingsRouter.post('/:id/approve', validate({ params: idParams }), itemsCtrl.approveMeeting);

// Email notifications (Phase 5): preview, explicit send, per-recipient status.
const sendLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `send-emails:${req.user.id}` });
meetingsRouter.get('/:id/emails/preview', validate({ params: idParams }), emailsCtrl.preview);
meetingsRouter.post('/:id/send-emails', sendLimiter, validate({ params: idParams }), emailsCtrl.send);
meetingsRouter.get('/:id/emails', validate({ params: idParams }), emailsCtrl.list);

// Vexa meeting bot (Phase 7). Requests are limited per admin; duplicates are refused by the DB claim.
const botLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (req) => `bot:${req.user.id}` });
meetingsRouter.get('/:id/bot', validate({ params: idParams }), botCtrl.get);
meetingsRouter.post('/:id/bot', botLimiter, validate({ params: idParams }), botCtrl.request);
meetingsRouter.delete('/:id/bot', botLimiter, validate({ params: idParams }), botCtrl.stop);
meetingsRouter.post('/:id/bot/check', botLimiter, validate({ params: idParams }), botCtrl.check);
meetingsRouter.post(
  '/:id/transcript/refresh',
  botLimiter,
  validate({ params: idParams, body: z.object({ replace: z.boolean().default(false) }).strict() }),
  botCtrl.importTranscript,
);
meetingsRouter.post(
  '/:id/transcript/upload',
  uploadJson,
  validate({ params: idParams, body: uploadSchema }),
  transcriptsCtrl.upload,
);
