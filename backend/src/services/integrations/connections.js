// Connection lifecycle (Phase 3A, docs/PHASE_3A_PLAN.md §5.3): connect via a single-use state,
// verify with the provider, store credentials, list resources, enable/disable, disconnect.
// Provider calls never run inside a database transaction.
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as authStates from '../../repositories/integrationAuthStatesRepository.js';
import * as connections from '../../repositories/integrationConnectionsRepository.js';
import * as resources from '../../repositories/integrationResourcesRepository.js';
import * as projects from '../../repositories/projectsRepository.js';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit.js';
import { randomToken, sha256 } from '../authService.js';
import { buildContext } from './context.js';
import { CredentialsKeyMissingError, CredentialsUnreadableError } from './crypto.js';
import { ProviderError } from './errors.js';
import { registry as defaultRegistry } from './registry.js';
import { vault } from './vault.js';

const STATE_TTL_SECONDS = 10 * 60;

// What completeConnect() and listResources() may return; anything else is the connector's bug.
const credentialSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  value: z.string().min(1),
  expiresAt: z.union([z.date(), z.string(), z.null()]).optional(),
});
const connectResultSchema = z.object({
  account: z.object({
    externalAccountId: z.string().trim().min(1).max(191),
    login: z.string().max(191).nullish(),
    type: z.string().max(32).nullish(),
    displayName: z.string().trim().min(1).max(200),
  }),
  settings: z.record(z.string(), z.unknown()).nullish(),
  credentials: z.array(credentialSchema).max(10).default([]),
});
const resourceSchema = z.object({
  resourceType: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  externalId: z.string().min(1).max(191),
  name: z.string().min(1).max(255),
  url: z.string().max(2048).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

/** Turns provider/credential failures into API errors with safe messages. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ProviderError) {
    const status = err.kind === 'rate_limited' ? 429 : err.kind === 'not_found' ? 404 : 502;
    return new AppError(status, 'PROVIDER_ERROR', err.publicMessage, [{ field: 'provider', message: err.kind }]);
  }
  if (err instanceof CredentialsKeyMissingError) return new AppError(503, 'INTEGRATIONS_NOT_CONFIGURED', 'CREDENTIALS_ENCRYPTION_KEY is not set on the server');
  if (err instanceof CredentialsUnreadableError) return new AppError(409, 'CREDENTIALS_UNREADABLE', 'Stored credentials cannot be read; reconnect the integration');
  return err;
}

function connectorError(connectorId, err, what) {
  if (err instanceof z.ZodError) {
    logger.error('connector returned an invalid result', { provider: connectorId, what, issues: err.issues.length });
    return new ProviderError('invalid_response', `${connectorId} ${what} returned an invalid result`);
  }
  return err;
}

export function createConnectionService({ registry = defaultRegistry } = {}) {
  function availableConnector(providerId) {
    if (!registry.get(providerId)) throw notFound('Unknown integration provider');
    const connector = registry.getAvailable(providerId);
    if (!connector) throw new AppError(503, 'PROVIDER_UNAVAILABLE', `This integration is not configured on the server: ${registry.problem(providerId)}`);
    return connector;
  }

  async function loadConnection(id, conn = pool) {
    const connection = await connections.findById(id, { conn });
    if (!connection) throw notFound('Integration not found');
    return connection;
  }

  /** Step 1: returns the URL that sends the admin to the provider. */
  async function startConnect({ providerId, actor }) {
    const connector = availableConnector(providerId);
    const state = randomToken();
    await authStates.create(pool, { provider: providerId, purpose: 'install', stateHash: sha256(state), userId: actor.id, ttlSeconds: STATE_TTL_SECONDS });
    const { redirectUrl } = await connector.beginConnect({ state });
    return { redirectUrl };
  }

  /** Re-reads the provider's resources: new ones are added (disabled), missing ones marked removed. */
  async function refreshResources(connectionId) {
    const connection = await loadConnection(connectionId);
    if (connection.status === 'disconnected') throw conflict('This integration is disconnected');
    const connector = availableConnector(connection.provider);
    let listed;
    try {
      listed = z.array(resourceSchema).max(5000).parse(await connector.listResources(buildContext(connector, connection)));
    } catch (err) {
      throw connectorError(connector.id, err, 'listResources');
    }
    await withTransaction(async (conn) => {
      for (const r of listed) await resources.upsert(conn, connectionId, r);
      for (const type of new Set([...listed.map((r) => r.resourceType), ...(await resources.listForConnection(connectionId, conn)).map((r) => r.resourceType)])) {
        await resources.markRemovedExcept(conn, connectionId, type, listed.filter((r) => r.resourceType === type).map((r) => r.externalId));
      }
    });
    return resources.listForConnection(connectionId);
  }

  /**
   * Step 2: the provider sent the admin back. Consumes the state (single use, same admin, 10 min),
   * lets the connector verify the account, then creates or reactivates the connection.
   */
  async function completeConnect({ providerId, actor, state, params, ip }) {
    const connector = availableConnector(providerId);
    // Consumed in its own transaction before calling the provider: a state never works twice.
    const consumed = await withTransaction((conn) => authStates.consume(conn, { stateHash: sha256(state), provider: providerId, userId: actor.id }));
    if (!consumed) throw new AppError(400, 'INVALID_STATE', 'This connection link is invalid or has expired. Start again from the Integrations page.');

    let result;
    try {
      const placeholder = { id: null, provider: connector.id, sourceInstance: connector.sourceInstance };
      result = connectResultSchema.parse(await connector.completeConnect(buildContext(connector, placeholder), { params }));
    } catch (err) {
      throw connectorError(connector.id, err, 'completeConnect');
    }
    const { account, settings, credentials } = result;

    const { connectionId, reconnected } = await withTransaction(async (conn) => {
      const existing = await connections.findByAccount(connector.id, connector.sourceInstance, account.externalAccountId, conn);
      const fields = {
        accountLogin: account.login ?? null,
        accountType: account.type ?? null,
        displayName: account.displayName,
        settings: settings ?? null,
        status: 'active',
        isEnabled: true,
        health: 'unknown',
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        pausedUntil: null,
        connectedBy: actor.id,
        connectedAt: new Date(),
        disconnectedBy: null,
        disconnectedAt: null,
      };
      let id;
      if (existing) {
        await connections.findById(existing.id, { conn, forUpdate: true });
        await connections.update(conn, existing.id, fields);
        id = existing.id;
      } else {
        id = await connections.create(conn, {
          provider: connector.id,
          sourceInstance: connector.sourceInstance,
          externalAccountId: account.externalAccountId,
          accountLogin: account.login,
          accountType: account.type,
          displayName: account.displayName,
          status: 'active',
          settings,
          connectedBy: actor.id,
        });
        await connections.update(conn, id, { connectedAt: new Date(), health: 'unknown' });
      }
      // Reconnecting replaces whatever credentials were stored before.
      await vault.remove(id, conn);
      for (const c of credentials) await vault.put({ connectionId: id, kind: c.kind, value: c.value, expiresAt: c.expiresAt ? new Date(c.expiresAt) : null }, conn);
      await recordAudit(conn, {
        actorUserId: actor.id,
        action: existing ? 'integration.reconnected' : 'integration.connected',
        entityType: 'integration_connection',
        entityId: id,
        after: { provider: connector.id, externalAccountId: account.externalAccountId, displayName: account.displayName, credentialKinds: credentials.map((c) => c.kind) },
        ip,
      });
      return { connectionId: id, reconnected: Boolean(existing) };
    });

    // Resources are listed after the connection is saved; a failure here leaves it connected.
    let resourceError = null;
    try {
      await refreshResources(connectionId);
    } catch (err) {
      resourceError = toAppError(err).message;
      await connections.update(pool, connectionId, { lastErrorCode: err.kind ?? 'resources', lastErrorMessage: resourceError.slice(0, 500) });
      logger.warn('listing resources after connect failed', { provider: connector.id, connectionId, error: err.message });
    }
    return { connection: await loadConnection(connectionId), resources: await resources.listForConnection(connectionId), reconnected, resourceError };
  }

  async function updateConnection(id, { isEnabled, displayName }, { actor, ip }) {
    return withTransaction(async (conn) => {
      const before = await connections.findById(id, { conn, forUpdate: true });
      if (!before) throw notFound('Integration not found');
      if (before.status === 'disconnected' && isEnabled) throw conflict('Reconnect this integration before enabling it');
      await connections.update(conn, id, { isEnabled, displayName });
      const after = await connections.findById(id, { conn });
      await recordAudit(conn, {
        actorUserId: actor.id,
        action: 'integration.updated',
        entityType: 'integration_connection',
        entityId: id,
        before: { isEnabled: before.isEnabled, displayName: before.displayName },
        after: { isEnabled: after.isEnabled, displayName: after.displayName },
        ip,
      });
      return after;
    });
  }

  async function updateResource(connectionId, resourceId, { isEnabled, projectId }, { actor, ip }) {
    if (projectId) {
      const project = await projects.findById(projectId);
      if (!project) throw badRequest('Invalid project', [{ field: 'projectId', message: 'Project not found' }]);
      if (project.status === 'archived') throw badRequest('Invalid project', [{ field: 'projectId', message: 'This project is archived' }]);
    }
    return withTransaction(async (conn) => {
      const before = await resources.findById(resourceId, { conn, forUpdate: true });
      if (!before || before.connectionId !== connectionId) throw notFound('Resource not found');
      if (isEnabled && before.accessStatus === 'removed') throw conflict('The provider no longer gives access to this resource');
      const connection = await connections.findById(connectionId, { conn });
      if (isEnabled && connection.status === 'disconnected') throw conflict('Reconnect this integration first');
      // Enabling makes the resource due for a sync right away (the scheduler picks it up).
      await resources.update(conn, resourceId, {
        isEnabled,
        projectId,
        nextSyncAt: isEnabled && !before.isEnabled ? new Date() : undefined,
      });
      const after = await resources.findById(resourceId, { conn });
      await recordAudit(conn, {
        actorUserId: actor.id,
        action: 'integration.resource_updated',
        entityType: 'integration_resource',
        entityId: resourceId,
        before: { isEnabled: before.isEnabled, projectId: before.projectId },
        after: { isEnabled: after.isEnabled, projectId: after.projectId },
        ip,
      });
      return after;
    });
  }

  /**
   * Deletes the stored credentials and marks the connection disconnected. Synced data is kept.
   * The provider-side revoke (and optional uninstall) is best effort and never blocks this.
   */
  async function disconnect(id, { uninstall = false } = {}, { actor, ip }) {
    const connection = await loadConnection(id);
    if (connection.status === 'disconnected') return connection;
    const connector = registry.get(connection.provider);
    if (connector?.disconnect) {
      try {
        await connector.disconnect(buildContext(connector, connection), { uninstall });
      } catch (err) {
        logger.warn('provider-side disconnect failed; disconnecting locally', { provider: connection.provider, connectionId: id, error: err.message });
      }
    }
    return withTransaction(async (conn) => {
      await connections.findById(id, { conn, forUpdate: true });
      const deleted = await vault.remove(id, conn);
      await connections.update(conn, id, {
        status: 'disconnected',
        isEnabled: false,
        health: 'unknown',
        pausedUntil: null,
        disconnectedBy: actor.id,
        disconnectedAt: new Date(),
      });
      await recordAudit(conn, {
        actorUserId: actor.id,
        action: 'integration.disconnected',
        entityType: 'integration_connection',
        entityId: id,
        after: { credentialsDeleted: deleted, uninstall },
        ip,
      });
      return connections.findById(id, { conn });
    });
  }

  return { startConnect, completeConnect, refreshResources, updateConnection, updateResource, disconnect, loadConnection };
}

export const connectionService = createConnectionService();
