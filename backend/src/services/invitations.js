// Employee onboarding (Phase 2): invite -> email with a one-time link -> set password -> sign in.
//
// Security model
// - Token: 32 random bytes (crypto.randomBytes), base64url. Only sha256(token) is stored, so a
//   database read does not reveal usable links. sha256 (not bcrypt) is enough because the token
//   is high-entropy, and it allows an indexed lookup.
// - The raw token exists only in memory while the email is sent, and in the email itself. It is
//   never logged, audited, returned by the API or stored in a job payload; that is why the email
//   is sent synchronously here instead of through the email.send job queue.
// - The link carries the token in the URL fragment, which browsers never send to servers.
// - Single use: accepting locks the invitation row, checks it is still open and marks it
//   accepted in the same transaction as setting the password.
// - Expiry: INVITATION_TTL_HOURS (default 72 h), checked against the database clock.
// - A new invitation revokes the user's previous open ones, so only the latest link works.
// - If the email cannot be sent, the invitation is revoked (status "failed"); there is no
//   fallback that shows the link to the admin.
// - Accepting fails if the user was deactivated, already has a password, or their email address
//   changed after the invitation was sent.
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import * as invitations from '../repositories/invitationsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { recordAudit } from './audit.js';
import { hashPassword, randomToken, revokeAllSessions, sha256 } from './authService.js';
import { email } from './email/index.js';
import { invitationLink, renderInvitationEmail } from './email/templates/invitationEmail.js';

export const invalidInvitation = () =>
  new AppError(400, 'INVALID_INVITATION', 'This invitation link is invalid or has already been used.');
export const expiredInvitation = () =>
  new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired. Ask your administrator to send a new one.');

/** Why invitations can't be sent right now, or null. */
export function invitationConfigProblem() {
  if (!email.isConfigured()) return email.configurationProblem();
  if (!config.email.appPublicUrl) return 'APP_PUBLIC_URL is not set';
  return null;
}

/**
 * Creates an invitation for an existing, active user without a password, revokes their older
 * open invitations and emails the link. Returns the invitation (API shape, no token).
 */
export async function sendInvitation({ userId, actor, ip }) {
  const user = await users.findAdminViewById(userId);
  if (!user) throw notFound('User not found');
  if (!user.is_active) throw conflict('This account is deactivated. Reactivate it before sending an invitation.');
  if (user.has_password) throw conflict('This person has already activated their account.');

  const problem = invitationConfigProblem();
  if (problem) {
    logger.warn('invitation not sent: email not configured', { problem });
    throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Invitation emails are not configured on the server.');
  }

  const token = randomToken();
  const invitationId = await withTransaction(async (conn) => {
    const replaced = await invitations.revokeOpen(conn, userId, actor.id);
    const id = await invitations.create(conn, {
      userId,
      tokenHash: sha256(token),
      email: user.email,
      createdBy: actor.id,
      ttlHours: config.invitations.ttlHours,
    });
    await recordAudit(conn, {
      actorUserId: actor.id,
      action: replaced ? 'user.invitation_resent' : 'user.invited',
      entityType: 'user',
      entityId: userId,
      after: { invitationId: id, email: user.email, replacedOpenInvitations: replaced },
      ip,
    });
    return id;
  });

  const created = await invitations.findById(invitationId);
  const message = renderInvitationEmail({
    recipient: { fullName: user.full_name },
    inviter: { fullName: actor.fullName },
    link: invitationLink(config.email.appPublicUrl, token),
    expiresAt: created.expires_at,
  });

  try {
    const provider = email.getProvider();
    await provider.send({
      from: email.from(),
      to: user.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      idempotencyKey: `invitation-${invitationId}`,
    });
  } catch (err) {
    const publicMessage = err?.publicMessage ?? 'The invitation email could not be sent';
    await invitations.markSendFailed(invitationId, publicMessage);
    // err.message is sanitized by the providers; it never contains the token (only the body does).
    logger.error('invitation email failed', { invitationId, userId, error: err?.message });
    throw new AppError(502, 'EMAIL_SEND_FAILED', `${publicMessage}. The invitation was not sent; try again.`);
  }
  await invitations.markSent(invitationId);
  logger.info('invitation sent', { invitationId, userId });
  return invitations.toInvitation(await invitations.findById(invitationId));
}

export async function revokeInvitation({ userId, actor, ip }) {
  const user = await users.findAdminViewById(userId);
  if (!user) throw notFound('User not found');
  await withTransaction(async (conn) => {
    const revoked = await invitations.revokeOpen(conn, userId, actor.id);
    if (!revoked) throw notFound('This person has no open invitation');
    await recordAudit(conn, { actorUserId: actor.id, action: 'user.invitation_revoked', entityType: 'user', entityId: userId, ip });
  });
}

/** Throws the right error unless the invitation row (from findByTokenHash) can be accepted. */
function assertAcceptable(row) {
  if (!row || row.accepted_at || row.revoked_at || row.send_error) throw invalidInvitation();
  if (!row.user_is_active || row.user_has_password || row.user_email !== row.email) throw invalidInvitation();
  if (Number(row.is_expired)) throw expiredInvitation();
}

const tokenHashOf = (token) => (typeof token === 'string' && token.length >= 20 && token.length <= 200 ? sha256(token) : null);

/** What the activation page may show before the password is chosen. */
export async function describeInvitation(token) {
  const hash = tokenHashOf(token);
  const row = hash && (await invitations.findByTokenHash(hash));
  assertAcceptable(row);
  return { email: row.email, fullName: row.user_full_name, expiresAt: row.expires_at };
}

/** Sets the password and consumes the invitation. Returns the activated user's id. */
export async function acceptInvitation({ token, password, ip }) {
  const hash = tokenHashOf(token);
  if (!hash) throw invalidInvitation();
  // Hash outside the transaction: bcrypt is slow and must not hold row locks.
  const passwordHash = await hashPassword(password);

  return withTransaction(async (conn) => {
    const row = await invitations.findByTokenHash(hash, { conn, forUpdate: true });
    assertAcceptable(row);
    // Guarded update: if a password appeared since the check, nothing changes and we refuse.
    const [result] = await conn.execute(
      'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL AND is_active = TRUE',
      [passwordHash, row.user_id],
    );
    if (result.affectedRows !== 1) throw invalidInvitation();
    await invitations.markAccepted(conn, row.id);
    await invitations.revokeOpen(conn, row.user_id, null);
    await revokeAllSessions(row.user_id, 'password_set', conn);
    await recordAudit(conn, {
      actorUserId: row.user_id,
      action: 'user.activated',
      entityType: 'user',
      entityId: row.user_id,
      after: { invitationId: row.id },
      ip,
    });
    return row.user_id;
  });
}
