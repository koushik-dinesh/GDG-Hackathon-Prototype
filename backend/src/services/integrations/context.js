// Builds the `ctx` a connector receives (docs/PHASE_3A_PLAN.md §5.1). Connectors only reach
// credentials, HTTP and logging through it, never the database.
import { logger } from '../../utils/logger.js';
import { createHttpClient } from './http.js';
import { vault as defaultVault } from './vault.js';

/**
 * @param connector the provider module
 * @param connection connection (API shape) or a placeholder { id: null, provider, sourceInstance }
 * @param {{ resource?, signal?: AbortSignal, vault? }} [options]
 */
export function buildContext(connector, connection, { resource = null, signal, vault = defaultVault } = {}) {
  const clients = [];
  const scoped = (level) => (msg, fields) => logger[level](msg, { provider: connector.id, connectionId: connection.id ?? null, ...fields });

  const ctx = {
    connection,
    resource,
    signal,
    logger: { debug: scoped('debug'), info: scoped('info'), warn: scoped('warn'), error: scoped('error') },

    credentials: {
      /** The stored credential value (refreshed through the connector when missing or expiring), or null. */
      async get(kind) {
        if (!connection.id) return null;
        const refresh = connector.refreshCredentials ? () => connector.refreshCredentials(ctx) : undefined;
        const found = await vault.get(connection.id, kind, { refresh });
        return found?.value ?? null;
      },
    },

    /** An HTTP client for this job; the framework reads its request counts and rate limits. */
    http(options) {
      const client = createHttpClient({ signal, ...options });
      clients.push(client);
      return client;
    },

    /** Totals across the clients created for this ctx: { requests, rateLimit (most recent) }. */
    httpStats() {
      let requests = 0;
      let rateLimit = null;
      for (const c of clients) {
        const s = c.stats();
        requests += s.requests;
        if (s.rateLimit) rateLimit = s.rateLimit;
      }
      return { requests, rateLimit };
    },
  };
  return ctx;
}
