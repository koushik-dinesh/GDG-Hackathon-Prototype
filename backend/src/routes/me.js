import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import * as users from '../repositories/usersRepository.js';
import { recordAudit } from '../services/audit.js';
import { hashPassword, verifyCredentials } from '../services/authService.js';
import { KINDS, getPreferences, kindsForRole, list, markRead, setPreferences, unreadCount } from '../services/notifications/inbox.js';
import { AppError, badRequest } from '../utils/errors.js';
import { id, idParams, newPassword } from '../utils/validation.js';

const profileSchema = z.object({ fullName: z.string().trim().min(1).max(200) }).strict();
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword }).strict();
const preferencesSchema = z
  .object({
    notifications: z.partialRecord(z.enum(Object.keys(KINDS)), z.boolean()).optional(),
    timeZone: z.string().max(64).nullable().optional(),
  })
  .strict();
const listQuery = z
  .object({ unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), before: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict();

// Same budget as login: password guesses through this endpoint are throttled too.
const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => `password:${req.user.id}` });

// The signed-in person's own profile, password, preferences and notifications (Phase 10).
// Mounted at /me behind requireAuth; everything is scoped to req.user.
export const meRouter = Router();

meRouter.get('/profile', async (req, res) => {
  res.json({ profile: { ...req.user, preferences: await getPreferences(req.user.id) }, notificationKinds: kindsForRole(req.user.role).map((kind) => ({ kind, label: KINDS[kind].label })) });
});

meRouter.patch('/profile', validate({ body: profileSchema }), async (req, res) => {
  await users.update(req.user.id, { fullName: req.body.fullName });
  await recordAudit(pool, { actorUserId: req.user.id, action: 'user.profile_updated', entityType: 'user', entityId: req.user.id, before: { fullName: req.user.fullName }, after: { fullName: req.body.fullName }, ip: req.ip });
  res.json({ user: users.toPublicUser(await users.findById(req.user.id)) });
});

meRouter.post('/password', passwordLimiter, validate({ body: passwordSchema }), async (req, res) => {
  if (!(await verifyCredentials(req.user.email, req.body.currentPassword))) {
    throw new AppError(400, 'INVALID_PASSWORD', 'The current password is not correct', [{ field: 'currentPassword', message: 'Not correct' }]);
  }
  if (req.body.newPassword === req.body.currentPassword) {
    throw new AppError(400, 'SAME_PASSWORD', 'Choose a password different from the current one', [{ field: 'newPassword', message: 'Must differ from the current password' }]);
  }
  const hash = await hashPassword(req.body.newPassword);
  const signedOut = await withTransaction(async (conn) => {
    await conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    // Every other session ends; this one stays signed in.
    const [result] = await conn.execute(
      "UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = 'password_changed' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
      [req.user.id, req.sessionId],
    );
    await recordAudit(conn, { actorUserId: req.user.id, action: 'user.password_changed', entityType: 'user', entityId: req.user.id, after: { otherSessionsRevoked: result.affectedRows }, ip: req.ip });
    return result.affectedRows;
  });
  res.json({ changed: true, otherSessionsSignedOut: signedOut });
});

meRouter.get('/preferences', async (req, res) => res.json({ preferences: await getPreferences(req.user.id) }));
meRouter.put('/preferences', validate({ body: preferencesSchema }), async (req, res) => {
  const allowed = kindsForRole(req.user.role);
  const refused = Object.keys(req.body.notifications ?? {}).filter((k) => !allowed.includes(k));
  if (refused.length) throw badRequest('Not available for your role', refused.map((k) => ({ field: `notifications.${k}`, message: 'Not available for your role' })));
  res.json({ preferences: await setPreferences(req.user.id, req.body) });
});

meRouter.get('/notifications', validate({ query: listQuery }), async (req, res) => res.json(await list(req.user.id, req.query)));
meRouter.get('/notifications/unread-count', async (req, res) => res.json({ unread: await unreadCount(req.user.id) }));
meRouter.post('/notifications/read-all', async (req, res) => res.json({ marked: await markRead(req.user.id) }));
meRouter.post('/notifications/:id/read', validate({ params: idParams }), async (req, res) => res.json({ marked: await markRead(req.user.id, req.params.id) }));
