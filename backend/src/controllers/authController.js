import { config } from '../config/index.js';
import { toPublicUser } from '../repositories/usersRepository.js';
import { audit } from '../services/audit.js';
import { revokeSession, sessionCookieOptions, signSession, verifyCredentials } from '../services/authService.js';
import { acceptInvitation, describeInvitation } from '../services/invitations.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await verifyCredentials(email, password);
  if (!user) {
    logger.warn('login failed', { ip: req.ip });
    // Same message for unknown email, wrong password, and inactive account.
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const { token, expiresAt } = await signSession(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(config.cookie.name, token, sessionCookieOptions(expiresAt));
  await audit({ actorUserId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip });
  res.json({ user: toPublicUser(user) });
}

// Revokes the server-side session, so the JWT stops working even if a copy of it was kept.
export async function logout(req, res) {
  await revokeSession(req.sessionId, 'logout');
  res.clearCookie(config.cookie.name, sessionCookieOptions());
  await audit({ actorUserId: req.user.id, action: 'auth.logout', entityType: 'user', entityId: req.user.id, ip: req.ip });
  res.status(204).end();
}

export function me(req, res) {
  res.json({ user: req.user });
}

// Public: the activation page shows who the invitation is for before a password is chosen.
export async function verifyInvitation(req, res) {
  res.json({ invitation: await describeInvitation(req.body.token) });
}

// Public: sets the password and consumes the invitation. The person then signs in normally.
export async function acceptInvitationHandler(req, res) {
  await acceptInvitation({ token: req.body.token, password: req.body.password, ip: req.ip });
  res.status(204).end();
}
