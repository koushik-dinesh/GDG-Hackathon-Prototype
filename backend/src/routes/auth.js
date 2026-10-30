import { Router } from 'express';
import { z } from 'zod';
import * as auth from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { newPassword } from '../utils/validation.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  password: z.string().min(1).max(200),
});

// The token is checked (and hashed) by the service; here only its shape is bounded.
const token = z.string().min(1).max(200);
const verifySchema = z.object({ token }).strict();
const acceptSchema = z.object({ token, password: newPassword }).strict();

// 10 attempts per IP+email per 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
});

// Invitation endpoints are public, so they are limited per IP: 20 checks and 10 activation
// attempts per 15 minutes. Tokens have 256 bits of entropy; this only stops noisy probing.
const invitationVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (req) => `invite-verify:${req.ip}` });
const invitationAcceptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `invite-accept:${req.ip}` });

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), auth.login);
authRouter.post('/logout', requireAuth, auth.logout);
authRouter.get('/me', requireAuth, auth.me);

authRouter.post('/invitations/verify', invitationVerifyLimiter, validate({ body: verifySchema }), auth.verifyInvitation);
authRouter.post('/invitations/accept', invitationAcceptLimiter, validate({ body: acceptSchema }), auth.acceptInvitationHandler);
