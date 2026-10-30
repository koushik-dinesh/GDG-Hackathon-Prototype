// Admin integration management (Phase 3A). Mounted behind requireAuth + requireRole('admin').
// Responses use the repositories' whitelisted shapes; credential values never leave the vault.
import { withTransaction } from '../db/transaction.js';
import * as identities from '../repositories/externalIdentitiesRepository.js';
import * as connections from '../repositories/integrationConnectionsRepository.js';
import * as users from '../repositories/usersRepository.js';
import * as resources from '../repositories/integrationResourcesRepository.js';
import * as deliveries from '../repositories/webhookDeliveriesRepository.js';
import { audit, recordAudit } from '../services/audit.js';
import { connectionService, toAppError } from '../services/integrations/connections.js';
import { registry } from '../services/integrations/registry.js';
import * as scheduler from '../services/integrations/scheduler.js';
import { vault } from '../services/integrations/vault.js';
import { webhookService } from '../services/integrations/webhooks.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';

// Provider and credential failures become API errors with safe messages.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    throw toAppError(err);
  }
};

const actorOf = (req) => ({ actor: req.user, ip: req.ip });

export const listProviders = handle(async (req, res) => {
  res.json({ providers: registry.list() });
});

export const list = handle(async (req, res) => {
  res.json({ connections: await connections.list({ provider: req.query.provider, status: req.query.status }) });
});

export const get = handle(async (req, res) => {
  const connection = await connectionService.loadConnection(req.params.id);
  const [resourceList, recentDeliveries, credentialKinds] = await Promise.all([
    resources.listForConnection(connection.id),
    deliveries.listForConnection(connection.id, { limit: 20 }),
    vault.describe(connection.id),
  ]);
  res.json({ connection, resources: resourceList, recentDeliveries, credentialKinds });
});

export const startConnect = handle(async (req, res) => {
  res.json(await connectionService.startConnect({ providerId: req.params.provider, actor: req.user }));
});

export const completeConnect = handle(async (req, res) => {
  const result = await connectionService.completeConnect({
    providerId: req.params.provider,
    actor: req.user,
    state: req.body.state,
    params: req.body.params,
    ip: req.ip,
  });
  res.status(result.reconnected ? 200 : 201).json(result);
});

export const update = handle(async (req, res) => {
  res.json({ connection: await connectionService.updateConnection(req.params.id, req.body, actorOf(req)) });
});

export const listResources = handle(async (req, res) => {
  await connectionService.loadConnection(req.params.id);
  res.json({ resources: await resources.listForConnection(req.params.id) });
});

export const refreshResources = handle(async (req, res) => {
  res.json({ resources: await connectionService.refreshResources(req.params.id) });
});

export const updateResource = handle(async (req, res) => {
  await connectionService.loadConnection(req.params.id);
  res.json({ resource: await connectionService.updateResource(req.params.id, req.params.resourceId, req.body, actorOf(req)) });
});

// Queues a sync of every enabled resource now (the worker runs it).
export const syncNow = handle(async (req, res) => {
  const connection = await connectionService.loadConnection(req.params.id);
  if (connection.status !== 'active' || !connection.isEnabled) throw conflict('Only active, enabled integrations can sync');
  const queued = await scheduler.syncConnectionNow(connection.id);
  await audit({ actorUserId: req.user.id, action: 'integration.sync_requested', entityType: 'integration_connection', entityId: connection.id, after: { queued }, ip: req.ip });
  res.status(202).json({ queued });
});

export const disconnect = handle(async (req, res) => {
  res.json({ connection: await connectionService.disconnect(req.params.id, req.body, actorOf(req)) });
});

export const listIdentities = handle(async (req, res) => {
  res.json({ identities: await identities.list({ provider: req.query.provider, unmatched: req.query.unmatched }) });
});

// An admin matches a person in a connected application to a WorkAgent user (or clears it).
export const matchIdentity = handle(async (req, res) => {
  const before = await identities.findById(req.params.id);
  if (!before) throw notFound('Identity not found');
  const { userId } = req.body;
  if (userId) {
    const user = await users.findById(userId);
    if (!user || !user.is_active) throw badRequest('Invalid user', [{ field: 'userId', message: 'Choose an active user' }]);
  }
  await withTransaction(async (conn) => {
    await identities.setManualMatch(conn, before.id, { userId, matchedBy: req.user.id });
    await recordAudit(conn, {
      actorUserId: req.user.id,
      action: 'external_identity.matched',
      entityType: 'external_identity',
      entityId: before.id,
      before: { userId: before.userId, matchMethod: before.matchMethod },
      after: { userId, matchMethod: userId ? 'manual' : 'none' },
      ip: req.ip,
    });
  });
  res.json({ identity: await identities.findById(before.id) });
});

// Re-queues a stored delivery (e.g. after fixing a mapping); 409 once its payload is purged.
export const replayDelivery = handle(async (req, res) => {
  res.status(202).json({ delivery: await webhookService.replay(req.params.id, actorOf(req)) });
});

export const listDeliveries = handle(async (req, res) => {
  const connection = await connections.findById(req.params.id);
  if (!connection) throw notFound('Integration not found');
  res.json({ deliveries: await deliveries.listForConnection(connection.id, { status: req.query.status, limit: req.query.limit }) });
});
