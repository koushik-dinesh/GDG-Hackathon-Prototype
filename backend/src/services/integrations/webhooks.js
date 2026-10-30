// Webhooks (docs/PHASE_3A_PLAN.md §7).
//
// receive(): the public endpoint. Verifies the signature over the raw bytes BEFORE parsing, stores
// the delivery and queues `integration.webhook` in one transaction, and makes no provider call,
// so it answers fast. Unsigned or badly signed requests are never stored.
//   - Duplicate delivery id: acknowledged and dropped, unless the earlier delivery failed (a
//     provider "redeliver" reuses the id), then it is queued again.
//
// process(): the worker. Binds the delivery to its connection, lets the connector turn it into
// envelopes and lifecycle changes, and ingests them with origin 'webhook'. Envelopes are only
// written for a resource the admin enabled (sync is opt-in; webhooks don't bypass that).
import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as queue from '../../jobs/queue.js';
import * as connections from '../../repositories/integrationConnectionsRepository.js';
import * as resources from '../../repositories/integrationResourcesRepository.js';
import * as deliveries from '../../repositories/webhookDeliveriesRepository.js';
import { AppError, conflict, notFound } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { recordAudit } from '../audit.js';
import { connectionService } from './connections.js';
import { buildContext } from './context.js';
import { ProviderError } from './errors.js';
import { ingest } from './ingest.js';
import { registry as defaultRegistry } from './registry.js';
import { vault } from './vault.js';

export const webhookDedupeKey = (deliveryRowId) => `webhook:${deliveryRowId}`;
const WEBHOOK_MAX_ATTEMPTS = 8;

const enqueueProcessing = (conn, deliveryRowId) =>
  queue.enqueue('integration.webhook', { deliveryId: deliveryRowId }, { dedupeKey: webhookDedupeKey(deliveryRowId), maxAttempts: WEBHOOK_MAX_ATTEMPTS, conn });

function isJson(headers) {
  const type = String(headers['content-type'] ?? '').toLowerCase();
  return type.startsWith('application/json') || /^application\/[a-z0-9.+-]+\+json/.test(type);
}

export function createWebhookService({ registry = defaultRegistry } = {}) {
  async function receive({ providerId, headers, rawBody }) {
    const connector = registry.getAvailable(providerId);
    // Unknown, unconfigured and webhook-less providers look the same from outside.
    if (!connector || !connector.capabilities.webhooks) throw notFound('Not found');
    if (!isJson(headers)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Webhooks must be sent as application/json');

    if (!connector.verifyWebhook({ headers, rawBody })) {
      logger.warn('webhook signature rejected', { provider: providerId, bytes: rawBody.length });
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    let parsed;
    try {
      parsed = connector.parseWebhook({ headers, body });
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(400, 'INVALID_WEBHOOK', 'Webhook is missing required headers or fields');
      throw err;
    }
    const deliveryId = String(parsed.deliveryId ?? '').slice(0, 191);
    const eventType = String(parsed.eventType ?? '').slice(0, 64);
    if (!deliveryId || !eventType) throw new AppError(400, 'INVALID_WEBHOOK', 'Webhook is missing its delivery id or event type');
    const externalAccountId = parsed.externalAccountId === null || parsed.externalAccountId === undefined ? null : String(parsed.externalAccountId);
    const connection = externalAccountId ? await connections.findByAccount(connector.id, connector.sourceInstance, externalAccountId) : null;

    const result = await withTransaction(async (conn) => {
      const stored = await deliveries.insert(conn, {
        provider: connector.id,
        deliveryId,
        eventType,
        action: parsed.action ? String(parsed.action).slice(0, 64) : null,
        externalAccountId,
        connectionId: connection?.id ?? null,
        payload: body,
        payloadBytes: rawBody.length,
        payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
      });
      if (!stored.duplicate) {
        const jobId = await enqueueProcessing(conn, stored.id);
        await deliveries.setStatus(conn, stored.id, 'received', { jobId });
        return { status: 'accepted', id: stored.id };
      }
      if (stored.delivery.status === 'failed' && stored.delivery.hasPayload) {
        const jobId = await enqueueProcessing(conn, stored.id);
        await deliveries.setStatus(conn, stored.id, 'received', { jobId, error: null });
        return { status: 'requeued', id: stored.id };
      }
      return { status: 'duplicate', id: stored.id };
    });
    if (connection && result.status !== 'duplicate') {
      await connections.update(pool, connection.id, { lastWebhookAt: new Date() }).catch(() => {});
    }
    return result;
  }

  async function applyLifecycle(connector, connection, lifecycle) {
    if (!lifecycle?.status || lifecycle.status === connection.status) return;
    // The provider can't reactivate a connection that is in error (credentials) or that an admin disconnected.
    if (lifecycle.status === 'active' && connection.status !== 'suspended') return;
    if (!['active', 'suspended', 'disconnected'].includes(lifecycle.status)) return;
    await withTransaction(async (conn) => {
      const fields = { status: lifecycle.status };
      if (lifecycle.status === 'disconnected') {
        await vault.remove(connection.id, conn);
        Object.assign(fields, { isEnabled: false, disconnectedAt: new Date(), disconnectedBy: null });
      }
      await connections.update(conn, connection.id, fields);
      await recordAudit(conn, {
        action: `integration.provider_${lifecycle.status === 'active' ? 'reactivated' : lifecycle.status}`,
        entityType: 'integration_connection',
        entityId: connection.id,
        before: { status: connection.status },
        after: { status: lifecycle.status },
      });
    });
    logger.info('integration status changed by provider', { provider: connector.id, connectionId: connection.id, status: lifecycle.status });
  }

  /** Processes one stored delivery (job integration.webhook). */
  async function processDelivery(deliveryRowId) {
    const delivery = await deliveries.findById(deliveryRowId);
    if (!delivery || delivery.status === 'processed' || delivery.status === 'ignored') return { status: delivery?.status ?? 'missing' };
    const ignore = async (reason) => {
      await deliveries.setStatus(pool, delivery.id, 'ignored', { error: reason });
      return { status: 'ignored', reason };
    };

    const connector = registry.getAvailable(delivery.provider);
    if (!connector) throw new queue.PermanentJobError(`Provider ${delivery.provider} is unavailable: ${registry.problem(delivery.provider)}`);

    let connection = delivery.connectionId ? await connections.findById(delivery.connectionId) : null;
    if (!connection && delivery.externalAccountId) {
      // The delivery arrived before the connection existed (e.g. during installation).
      connection = await connections.findByAccount(connector.id, connector.sourceInstance, delivery.externalAccountId);
      if (connection) await deliveries.setStatus(pool, delivery.id, delivery.status, { connectionId: connection.id });
    }
    if (!connection) return ignore('No connection for this account');
    if (connection.status === 'disconnected' || !connection.isEnabled) return ignore('Integration is disconnected or paused');

    const payload = await deliveries.findPayload(delivery.id);
    if (payload === null) throw new queue.PermanentJobError('Webhook payload was purged');

    await deliveries.setStatus(pool, delivery.id, 'processing', { countAttempt: true });
    let result;
    try {
      result = await connector.handleWebhook(buildContext(connector, connection), {
        deliveryId: delivery.deliveryId,
        eventType: delivery.eventType,
        action: delivery.action,
        externalAccountId: delivery.externalAccountId,
        payload,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'rate_limited') {
        await deliveries.setStatus(pool, delivery.id, 'received');
        throw new queue.RescheduleJob(err.waitMs(), 'provider rate limit');
      }
      await deliveries.setStatus(pool, delivery.id, 'received', { error: err.publicMessage ?? err.message });
      throw err;
    }

    await applyLifecycle(connector, connection, result?.lifecycle);
    // Access changed at the provider (repositories added/removed, renamed, permissions): re-read
    // the resource list. New resources arrive disabled; admin choices are kept.
    if (result?.lifecycle?.refreshResources && result.lifecycle.status !== 'disconnected') {
      await connectionService.refreshResources(connection.id);
    }
    const envelopes = result?.envelopes ?? [];
    if (envelopes.length === 0) {
      await deliveries.setStatus(pool, delivery.id, 'processed', { error: null });
      return { status: 'processed', ingested: null };
    }

    // Envelopes belong to a resource; only enabled, accessible ones are written.
    const ref = result.resourceRef;
    const resource = ref
      ? (await resources.listForConnection(connection.id)).find((r) => r.resourceType === ref.resourceType && r.externalId === String(ref.externalId))
      : null;
    if (!resource || !resource.isEnabled || resource.accessStatus !== 'accessible') return ignore('Resource is not enabled for sync');

    const stats = await withTransaction(async (conn) => {
      const s = await ingest(conn, { connector, connection, resource, envelopes, origin: 'webhook', webhookDeliveryId: delivery.id });
      await deliveries.setStatus(conn, delivery.id, 'processed', { error: null });
      return s;
    });
    return { status: 'processed', ingested: stats };
  }

  /** The job gave up: keep the delivery visible as failed (it can be replayed). */
  async function onFinalFailure(deliveryRowId, err) {
    await deliveries.setStatus(pool, deliveryRowId, 'failed', { error: err?.publicMessage ?? err?.message ?? 'Processing failed' });
  }

  /** Admin replay of a stored delivery. */
  async function replay(deliveryRowId, { actor, ip }) {
    return withTransaction(async (conn) => {
      const delivery = await deliveries.findById(deliveryRowId, { conn, forUpdate: true });
      if (!delivery) throw notFound('Webhook delivery not found');
      if (!delivery.hasPayload) throw conflict('This delivery’s payload was deleted after the retention period');
      if (delivery.status === 'processing' || delivery.status === 'received') throw conflict('This delivery is already queued');
      let jobId;
      try {
        jobId = await enqueueProcessing(conn, delivery.id);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw conflict('This delivery is already queued');
        throw err;
      }
      await deliveries.setStatus(conn, delivery.id, 'received', { jobId, error: null });
      await recordAudit(conn, {
        actorUserId: actor.id,
        action: 'integration.webhook_replayed',
        entityType: 'webhook_delivery',
        entityId: delivery.id,
        before: { status: delivery.status },
        ip,
      });
      return deliveries.findById(delivery.id, { conn });
    });
  }

  return { receive, processDelivery, onFinalFailure, replay };
}

export const webhookService = createWebhookService();
