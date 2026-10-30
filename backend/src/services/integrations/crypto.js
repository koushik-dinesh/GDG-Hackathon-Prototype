// Encryption for integration credentials (Phase 3A, docs/PHASE_3A_PLAN.md §6).
//
// - AES-256-GCM with a random 96-bit IV per encryption and a 128-bit auth tag.
// - Additional authenticated data (AAD) binds a ciphertext to where it is stored (the vault uses
//   connection id + credential kind), so a ciphertext copied to another row fails to decrypt.
// - Keys come from CREDENTIALS_ENCRYPTION_KEY (current) and CREDENTIALS_ENCRYPTION_KEY_PREVIOUS
//   (optional, during rotation). Each ciphertext records the id of the key that made it; the id is
//   an HMAC of the key, so it identifies the key without revealing anything about it.
// - Errors never include key material, plaintext or ciphertext.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** No usable current key is configured, so nothing can be encrypted. */
export class CredentialsKeyMissingError extends Error {
  constructor() {
    super('CREDENTIALS_ENCRYPTION_KEY is not set');
    this.name = 'CredentialsKeyMissingError';
  }
}

/** A stored credential can't be decrypted: unknown key, tampered data or wrong AAD. */
export class CredentialsUnreadableError extends Error {
  constructor(reason) {
    super(`Stored credentials cannot be decrypted (${reason})`);
    this.name = 'CredentialsUnreadableError';
  }
}

/** 16 hex chars identifying a key: HMAC-SHA256(key, label), truncated. */
export function keyId(key) {
  return createHmac('sha256', key).update('workagent-key-id').digest('hex').slice(0, 16);
}

function assertKey(key, name) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes`);
}

function assertAad(aad) {
  if (typeof aad !== 'string' || aad.length === 0) throw new Error('AAD is required');
}

/**
 * Builds a keyring from Buffers. `current` may be null (encryption then throws
 * CredentialsKeyMissingError); `previous` is only used to decrypt.
 */
export function createKeyring({ current = null, previous = null } = {}) {
  if (current) assertKey(current, 'current key');
  if (previous) assertKey(previous, 'previous key');
  const keys = new Map();
  if (current) keys.set(keyId(current), current);
  if (previous) keys.set(keyId(previous), previous);
  const currentId = current ? keyId(current) : null;

  return {
    currentKeyId: currentId,
    isConfigured: () => Boolean(current),

    /** Encrypts a UTF-8 string. Returns { keyId, iv, authTag, ciphertext } (Buffers + id). */
    encrypt(plaintext, aad) {
      if (!current) throw new CredentialsKeyMissingError();
      if (typeof plaintext !== 'string') throw new Error('plaintext must be a string');
      assertAad(aad);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, current, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return { keyId: currentId, iv, authTag: cipher.getAuthTag(), ciphertext };
    },

    /** Decrypts what encrypt() returned (with the same AAD). Throws CredentialsUnreadableError. */
    decrypt({ keyId: id, iv, authTag, ciphertext }, aad) {
      assertAad(aad);
      const key = keys.get(id);
      if (!key) throw new CredentialsUnreadableError('unknown key');
      if (iv?.length !== IV_BYTES || authTag?.length !== TAG_BYTES || !Buffer.isBuffer(ciphertext)) {
        throw new CredentialsUnreadableError('malformed');
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new CredentialsUnreadableError('authentication failed');
      }
    },

    /** True when a ciphertext was made with a key other than the current one (rotation). */
    needsReencrypt: (id) => id !== currentId,
  };
}

/** The deployment's keyring, from config. */
export const keyring = createKeyring(config.integrations.encryptionKeys);
