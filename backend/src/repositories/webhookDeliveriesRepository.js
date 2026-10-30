// Inbound webhook deliveries (Phase 3A). A delivery is stored before it is processed, so it can be
// retried and replayed. Payloads are never returned by toDelivery() (API/listing shape).
import { pool } from '../db/pool.js';

export const toDelivery = (row) => ({
  id: row.id,
  provider: row.provider,
  deliveryId: row.delivery_id,
  eventType: row.event_type,
  action: row.action,
  externalAccountId: row.external_account_id,
  connectionId: row.connection_id,
  payloadBytes: row.payload_bytes,
  hasPayload: row.payload_purged_at === null,
  status: row.status,
  attempts: row.attempts,
  lastErrorMessage: row.last_error_message,
  jobId: row.job_id,
  receivedAt: row.received_at,
  processedAt: row.processed_at,
  payloadPurgedAt: row.payload_purged_at,
});

const SUMMARY_COLUMNS = `id, provider, delivery_id, event_type, action, external_account_id, connection_id, payload_bytes,
  status, attempts, last_error_message, job_id, received_at, processed_at, payload_purged_at`;

/**
 * Stores a delivery. If (provider, delivery_id) already exists nothing is written and the existing
 * row is returned with duplicate=true (the caller decides whether a redelivery is re-queued).
 * Returns { id, duplicate, delivery }.
 */
export async function insert(conn, { provider, deliveryId, eventType, action, externalAccountId, connectionId, payload, payloadBytes, payloadSha256 }) {
  // Not INSERT IGNORE: that would also turn foreign-key and truncation errors into warnings.
  try {
    const [result] = await conn.execute(
      `INSERT INTO webhook_deliveries
         (provider, delivery_id, event_type, action, external_account_id, connection_id, payload, payload_bytes, payload_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        provider,
        deliveryId,
        eventType,
        action ?? null,
        externalAccountId === undefined || externalAccountId === null ? null : String(externalAccountId),
        connectionId ?? null,
        JSON.stringify(payload),
        payloadBytes,
        payloadSha256,
      ],
    );
    return { id: result.insertId, duplicate: false, delivery: await findById(result.insertId, { conn }) };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  const [rows] = await conn.query(`SELECT ${SUMMARY_COLUMNS} FROM webhook_deliveries WHERE provider = ? AND delivery_id = ? FOR UPDATE`, [provider, deliveryId]);
  return { id: rows[0].id, duplicate: true, delivery: toDelivery(rows[0]) };
}

export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT ${SUMMARY_COLUMNS} FROM webhook_deliveries WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? toDelivery(rows[0]) : null;
}

/** The stored payload (parsed JSON), or null once purged. Only the webhook processor uses this. */
export async function findPayload(id, conn = pool) {
  const [rows] = await conn.query('SELECT payload FROM webhook_deliveries WHERE id = ?', [id]);
  const p = rows[0]?.payload;
  return typeof p === 'string' ? JSON.parse(p) : p ?? null;
}

export async function listForConnection(connectionId, { status, limit = 50 } = {}) {
  const [rows] = await pool.query(
    `SELECT ${SUMMARY_COLUMNS} FROM webhook_deliveries
     WHERE connection_id = ? ${status ? 'AND status = ?' : ''}
     ORDER BY received_at DESC, id DESC LIMIT ?`,
    status ? [connectionId, status, limit] : [connectionId, limit],
  );
  return rows.map(toDelivery);
}

/** Retention: drops payloads older than `days`. Metadata stays for the delivery history. */
export async function purgePayloadsOlderThan(days, conn = pool) {
  const [result] = await conn.execute(
    `UPDATE webhook_deliveries SET payload = NULL, payload_purged_at = NOW()
     WHERE payload_purged_at IS NULL AND received_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days],
  );
  return result.affectedRows;
}
