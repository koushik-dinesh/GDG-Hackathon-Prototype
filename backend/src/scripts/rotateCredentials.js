// Re-encrypts stored integration credentials with the current CREDENTIALS_ENCRYPTION_KEY.
// Usage (after moving the old key to CREDENTIALS_ENCRYPTION_KEY_PREVIOUS and restarting):
//   npm run credentials:rotate
// Safe to run repeatedly. Exits 1 if some rows can't be decrypted with either key; those
// connections must be reconnected.
import { pool } from '../db/pool.js';
import { keyring } from '../services/integrations/crypto.js';
import { vault } from '../services/integrations/vault.js';
import { logger } from '../utils/logger.js';

try {
  if (!keyring.isConfigured()) throw new Error('CREDENTIALS_ENCRYPTION_KEY is not set');
  const { reencrypted, unreadable } = await vault.rotate();
  logger.info('credential rotation finished', { reencrypted, unreadable, currentKeyId: keyring.currentKeyId });
  process.exitCode = unreadable > 0 ? 1 : 0;
} catch (err) {
  logger.error('credential rotation failed', { error: err.message });
  process.exitCode = 1;
} finally {
  await pool.end();
}
