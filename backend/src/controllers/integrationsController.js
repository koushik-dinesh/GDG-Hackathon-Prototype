// Admin integration management (Phase 3A). Mounted behind requireAuth + requireRole('admin').
// Responses use the repositories' whitelisted shapes; credential values never leave the vault.
import * as connections from '../repositories/integrationConnectionsRepository.js';
import * as resources from '../repositories/integrationResourcesRepository.js';
import * as deliveries from '../repositories/webhookDeliveriesRepository.js';
import { connectionService, toAppError } from '../services/integrations/connections.js';
import { registry } from '../services/integrations/registry.js';
import { vault } from '../services/integrations/vault.js';
import { notFound } from '../utils/errors.js';

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

export const disconnect = handle(async (req, res) => {
  res.json({ connection: await connectionService.disconnect(req.params.id, req.body, actorOf(req)) });
});

export const listDeliveries = handle(async (req, res) => {
  const connection = await connections.findById(req.params.id);
  if (!connection) throw notFound('Integration not found');
  res.json({ deliveries: await deliveries.listForConnection(connection.id, { status: req.query.status, limit: req.query.limit }) });
});
