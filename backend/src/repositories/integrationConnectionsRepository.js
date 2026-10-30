// Integration connections (Phase 3A): one authorized account or installation per row.
// Rows are never deleted; disconnecting keeps the row so synced records stay attributable.
// Credentials live in integration_credentials and are never joined here.
import { pool } from '../db/pool.js';

export const CONNECTION_STATUSES = ['pending', 'active', 'suspended', 'error', 'disconnected'];
export const CONNECTION_HEALTH = ['unknown', 'healthy', 'degraded', 'failing'];

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

/** API shape. Lists every field explicitly so nothing new leaks into responses by accident. */
export const toConnection = (row) => ({
  id: row.id,
  provider: row.provider,
  sourceInstance: row.source_instance,
  externalAccountId: row.external_account_id,
  accountLogin: row.account_login,
  accountType: row.account_type,
  displayName: row.display_name,
  status: row.status,
  isEnabled: Boolean(row.is_enabled),
  settings: parseJson(row.settings),
  health: row.health,
  consecutiveFailures: row.consecutive_failures,
  lastErrorCode: row.last_error_code,
  lastErrorMessage: row.last_error_message,
  rateLimitRemaining: row.rate_limit_remaining,
  pausedUntil: row.paused_until,
  lastSyncStartedAt: row.last_sync_started_at,
  lastSyncSucceededAt: row.last_sync_succeeded_at,
  lastWebhookAt: row.last_webhook_at,
  connectedBy: row.connected_by,
  connectedAt: row.connected_at,
  disconnectedBy: row.disconnected_by,
  disconnectedAt: row.disconnected_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// API field -> column, for update(). Anything else is rejected.
const COLUMNS = {
  accountLogin: 'account_login',
  accountType: 'account_type',
  displayName: 'display_name',
  status: 'status',
  isEnabled: 'is_enabled',
  settings: 'settings',
  health: 'health',
  consecutiveFailures: 'consecutive_failures',
  lastErrorCode: 'last_error_code',
  lastErrorMessage: 'last_error_message',
  rateLimitRemaining: 'rate_limit_remaining',
  pausedUntil: 'paused_until',
  lastSyncStartedAt: 'last_sync_started_at',
  lastSyncSucceededAt: 'last_sync_succeeded_at',
  lastWebhookAt: 'last_webhook_at',
  connectedBy: 'connected_by',
  connectedAt: 'connected_at',
  disconnectedBy: 'disconnected_by',
  disconnectedAt: 'disconnected_at',
};

const toValue = (field, value) => (field === 'settings' && value !== null && value !== undefined ? JSON.stringify(value) : value);

export async function create(
  conn,
  { provider, sourceInstance, externalAccountId, accountLogin, accountType, displayName, status = 'pending', settings, connectedBy },
) {
  const [result] = await conn.execute(
    `INSERT INTO integration_connections
       (provider, source_instance, external_account_id, account_login, account_type, display_name, status, settings, connected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      provider,
      sourceInstance,
      String(externalAccountId),
      accountLogin ?? null,
      accountType ?? null,
      displayName,
      status,
      settings ? JSON.stringify(settings) : null,
      connectedBy ?? null,
    ],
  );
  return result.insertId;
}

export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT * FROM integration_connections WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function findByAccount(provider, sourceInstance, externalAccountId, conn = pool) {
  const [rows] = await conn.query(
    'SELECT * FROM integration_connections WHERE provider = ? AND source_instance = ? AND external_account_id = ?',
    [provider, sourceInstance, String(externalAccountId)],
  );
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function list({ provider, status } = {}) {
  const where = [];
  const params = [];
  if (provider) {
    where.push('provider = ?');
    params.push(provider);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const [rows] = await pool.query(
    `SELECT * FROM integration_connections ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY status = 'disconnected', display_name, id`,
    params,
  );
  return rows.map(toConnection);
}

/** Updates the given fields (API names, see COLUMNS). Returns the number of rows changed. */
export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  for (const [field] of entries) {
    if (!COLUMNS[field]) throw new Error(`Unknown connection field: ${field}`);
  }
  if (entries.length === 0) return 0;
  const [result] = await conn.execute(
    `UPDATE integration_connections SET ${entries.map(([f]) => `${COLUMNS[f]} = ?`).join(', ')} WHERE id = ?`,
    [...entries.map(([f, v]) => toValue(f, v)), id],
  );
  return result.affectedRows;
}
