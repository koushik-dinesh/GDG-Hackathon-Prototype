import { pool } from '../db/pool.js';
import * as aliases from '../repositories/aliasesRepository.js';
import * as invitations from '../repositories/invitationsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { audit } from '../services/audit.js';
import { revokeAllSessions } from '../services/authService.js';
import { revokeInvitation, sendInvitation } from '../services/invitations.js';
import { normalizeName } from '../services/matching/normalize.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';

async function loadUser(id) {
  const row = await users.findAdminViewById(id);
  if (!row) throw notFound('User not found');
  return row;
}

export async function list(req, res) {
  const [rows, aliasRows, latestInvitations] = await Promise.all([
    users.list({ includeInactive: req.query.includeInactive }),
    aliases.listAll(),
    invitations.latestByUser(),
  ]);
  const byUser = Map.groupBy(aliasRows.map(aliases.toAlias), (a) => a.userId);
  res.json({
    users: rows.map((r) => ({
      ...users.toAdminUser(r),
      aliases: byUser.get(r.id) ?? [],
      invitation: latestInvitations.get(r.id) ?? null,
    })),
  });
}

// Creates the account without a password. It can be assigned tasks now; the person activates it
// through an invitation (POST /users/:id/invitations), which lets them choose a password.
export async function create(req, res) {
  let id;
  try {
    id = await users.create({ ...req.body, passwordHash: null });
  } catch (err) {
    if (isDuplicate(err)) throw conflict('A user with this email already exists');
    throw err;
  }
  const user = users.toAdminUser(await loadUser(id));
  await audit({ actorUserId: req.user.id, action: 'user.created', entityType: 'user', entityId: id, after: user, ip: req.ip });
  res.status(201).json({ user: { ...user, aliases: [], invitation: null } });
}

export async function update(req, res) {
  const { id } = req.params;
  const before = users.toAdminUser(await loadUser(id));

  // Prevent admins from locking themselves out.
  if (id === req.user.id) {
    if (req.body.role && req.body.role !== 'admin') throw badRequest('You cannot change your own role');
    if (req.body.isActive === false) throw badRequest('You cannot deactivate your own account');
  }

  try {
    await users.update(id, req.body);
  } catch (err) {
    if (isDuplicate(err)) throw conflict('A user with this email already exists');
    throw err;
  }
  // Deactivation ends every session at once (requireAuth would also refuse them).
  if (req.body.isActive === false && before.isActive) {
    await revokeAllSessions(id, 'deactivated');
    await invitations.revokeOpen(pool, id, req.user.id);
  }
  const after = users.toAdminUser(await loadUser(id));
  await audit({ actorUserId: req.user.id, action: 'user.updated', entityType: 'user', entityId: id, before, after, ip: req.ip });
  const [aliasRows, invitationList] = await Promise.all([aliases.listForUser(id), invitations.listForUser(id)]);
  res.json({ user: { ...after, aliases: aliasRows.map(aliases.toAlias), invitation: invitationList[0] ?? null } });
}

// Soft delete: deactivated users keep their history (tasks, meetings, memberships, audit) but
// can't log in or be assigned. Their sessions and open invitations are revoked immediately.
export async function deactivate(req, res) {
  const { id } = req.params;
  if (id === req.user.id) throw badRequest('You cannot deactivate your own account');
  const before = users.toAdminUser(await loadUser(id));
  await users.update(id, { isActive: false });
  await revokeAllSessions(id, 'deactivated');
  await revokeInvitation({ userId: id, actor: req.user, ip: req.ip }).catch((err) => {
    if (err.status !== 404) throw err; // 404 = no open invitation, which is fine
  });
  await audit({
    actorUserId: req.user.id,
    action: 'user.deactivated',
    entityType: 'user',
    entityId: id,
    before,
    after: { ...before, isActive: false },
    ip: req.ip,
  });
  res.status(204).end();
}

export async function listAliases(req, res) {
  await loadUser(req.params.id);
  res.json({ aliases: (await aliases.listForUser(req.params.id)).map(aliases.toAlias) });
}

export async function addAlias(req, res) {
  const { id } = req.params;
  await loadUser(id);
  const normalized = normalizeName(req.body.alias);
  if (!normalized) throw badRequest('Alias must contain letters or numbers');

  let aliasId;
  try {
    aliasId = await aliases.create(id, req.body.alias, normalized);
  } catch (err) {
    if (isDuplicate(err)) throw conflict('This user already has that alias');
    throw err;
  }
  const alias = aliases.toAlias(await aliases.findById(id, aliasId));
  // Shared aliases are allowed (two "Sam"s), but they will make matching ambiguous.
  const sharedWith = (await aliases.findOwnersOfNormalized(normalized, id)).map((u) => ({ id: u.id, fullName: u.full_name }));
  await audit({ actorUserId: req.user.id, action: 'user_alias.created', entityType: 'user', entityId: id, after: alias, ip: req.ip });
  res.status(201).json({ alias, sharedWith });
}

export async function removeAlias(req, res) {
  const { id, aliasId } = req.params;
  const existing = await aliases.findById(id, aliasId);
  if (!existing) throw notFound('Alias not found');
  await aliases.remove(id, aliasId);
  await audit({
    actorUserId: req.user.id,
    action: 'user_alias.deleted',
    entityType: 'user',
    entityId: id,
    before: aliases.toAlias(existing),
    ip: req.ip,
  });
  res.status(204).end();
}

export async function listInvitations(req, res) {
  await loadUser(req.params.id);
  res.json({ invitations: await invitations.listForUser(req.params.id) });
}

// Sends a new invitation (also used to resend: older open links stop working).
export async function invite(req, res) {
  const invitation = await sendInvitation({ userId: req.params.id, actor: req.user, ip: req.ip });
  res.status(201).json({ invitation });
}

export async function revokeInvite(req, res) {
  await revokeInvitation({ userId: req.params.id, actor: req.user, ip: req.ip });
  res.status(204).end();
}
