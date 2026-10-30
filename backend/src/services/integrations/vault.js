// Credential vault (Phase 3A, docs/PHASE_3A_PLAN.md §6). The only code that reads or writes
// integration_credentials. Values are encrypted with the deployment keyring, bound (via AAD) to
// their connection and kind, and only ever returned to connector code through ctx.credentials.
//
// - put/get/remove are the whole API for connectors' credentials.
// - get() can refresh: pass `refresh` and the vault stores and returns new credentials when the
//   stored one is missing or expires within `refreshBeforeMs`. Two workers refreshing at once
//   both store a valid credential (last write wins), which is fine for short-lived tokens.
// - Rows made with the previous key are re-encrypted with the current key when read, and in bulk
//   by `npm run credentials:rotate`.
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import * as credentials from '../../repositories/integrationCredentialsRepository.js';
import { logger } from '../../utils/logger.js';
import { keyring as defaultKeyring } from './crypto.js';

const KIND = /^[a-z][a-z0-9_]{1,31}$/;
// VARBINARY(16384) holds the ciphertext; GCM adds no padding, so this bounds the UTF-8 plaintext.
const MAX_VALUE_BYTES = 16_000;
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000;

/** Binds a ciphertext to the row it belongs to. Changing this string makes stored rows unreadable. */
export const credentialAad = (connectionId, kind) => `workagent:cred:v1:${connectionId}:${kind}`;

function assertInput(connectionId, kind) {
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) throw new Error('connectionId must be a positive integer');
  if (!KIND.test(kind)) throw new Error(`Invalid credential kind: ${kind}`);
}

function assertValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Credential value must be a non-empty string');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new Error(`Credential value exceeds ${MAX_VALUE_BYTES} bytes`);
}

const toDate = (v) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v));

/** A vault over a keyring. Tests build their own; the app uses `vault` below. */
export function createVault(keyring = defaultKeyring) {
  async function put({ connectionId, kind, value, expiresAt = null }, conn = pool) {
    assertInput(connectionId, kind);
    assertValue(value);
    const sealed = keyring.encrypt(value, credentialAad(connectionId, kind));
    await credentials.upsert(conn, { connectionId, kind, sealed, expiresAt: toDate(expiresAt) });
  }

  async function reencrypt(row, value) {
    try {
      await withTransaction(async (conn) => {
        const current = await credentials.findByIdForUpdate(conn, row.id);
        // Skip if it changed meanwhile (someone stored a new value, or another reader rotated it).
        if (!current || current.keyId !== row.keyId || !current.ciphertext.equals(row.ciphertext)) return;
        await credentials.replaceSealed(conn, row.id, keyring.encrypt(value, credentialAad(row.connectionId, row.kind)));
      });
    } catch (err) {
      logger.warn('credential re-encryption failed', { credentialId: row.id, error: err.message });
    }
  }

  /** Decrypts a stored row; throws CredentialsUnreadableError if it can't be decrypted. */
  function open(row) {
    return keyring.decrypt(row, credentialAad(row.connectionId, row.kind));
  }

  /**
   * Returns { value, expiresAt } or null. With `refresh` (an async function returning
   * [{ kind, value, expiresAt }]), missing or soon-to-expire credentials are refreshed first.
   */
  async function get(connectionId, kind, { refresh, refreshBeforeMs = DEFAULT_REFRESH_BEFORE_MS } = {}) {
    assertInput(connectionId, kind);
    const row = await credentials.find(connectionId, kind);
    const expiresSoon = row?.expiresAt && row.expiresAt.getTime() - Date.now() <= refreshBeforeMs;
    if (refresh && (!row || expiresSoon)) {
      const fresh = await refresh();
      if (!Array.isArray(fresh)) throw new Error('refresh() must return an array of credentials');
      await withTransaction(async (conn) => {
        for (const c of fresh) await put({ connectionId, kind: c.kind, value: c.value, expiresAt: c.expiresAt }, conn);
      });
      const wanted = fresh.find((c) => c.kind === kind);
      if (!wanted) throw new Error(`refresh() did not return a "${kind}" credential`);
      return { value: wanted.value, expiresAt: toDate(wanted.expiresAt) };
    }
    if (!row) return null;
    const value = open(row);
    if (keyring.needsReencrypt(row.keyId)) await reencrypt(row, value);
    return { value, expiresAt: row.expiresAt };
  }

  /** Deletes every credential of a connection (disconnect). Returns how many were deleted. */
  const remove = (connectionId, conn = pool) => credentials.deleteForConnection(conn, connectionId);

  /** Which kinds are stored (no values), e.g. for a health view. */
  const describe = (connectionId) => credentials.kindsForConnection(connectionId);

  /**
   * Re-encrypts every row not on the current key, one row per transaction. Idempotent.
   * Returns { reencrypted, unreadable } (unreadable rows need their connection reconnected).
   */
  async function rotate({ batchSize = 100 } = {}) {
    let reencrypted = 0;
    let unreadable = 0;
    let afterId = 0;
    for (;;) {
      const ids = await credentials.listIdsNotOnKey(keyring.currentKeyId, { afterId, limit: batchSize });
      if (ids.length === 0) break;
      for (const id of ids) {
        afterId = id;
        const done = await withTransaction(async (conn) => {
          const row = await credentials.findByIdForUpdate(conn, id);
          if (!row || !keyring.needsReencrypt(row.keyId)) return false;
          let value;
          try {
            value = open(row);
          } catch {
            return null;
          }
          await credentials.replaceSealed(conn, id, keyring.encrypt(value, credentialAad(row.connectionId, row.kind)));
          return true;
        });
        if (done === true) reencrypted++;
        else if (done === null) {
          unreadable++;
          logger.warn('credential cannot be decrypted with the configured keys', { credentialId: id });
        }
      }
    }
    return { reencrypted, unreadable };
  }

  return { put, get, remove, describe, rotate };
}

export const vault = createVault();
