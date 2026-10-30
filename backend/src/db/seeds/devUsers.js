// Development-only seed. Creates the admin (required) and a manager and an employee (optional)
// from SEED_* environment variables. Existing users are left untouched.
import { config } from '../../config/index.js';
import { pool } from '../pool.js';
import * as users from '../../repositories/usersRepository.js';
import { hashPassword } from '../../services/authService.js';
import { logger } from '../../utils/logger.js';

const MIN_PASSWORD_LENGTH = 12;

function readAccount(prefix, role, required) {
  const email = process.env[`${prefix}_EMAIL`]?.trim().toLowerCase();
  const password = process.env[`${prefix}_PASSWORD`];
  const fullName = process.env[`${prefix}_NAME`]?.trim() || ({ admin: 'Dev Admin', manager: 'Dev Manager' }[role] ?? 'Dev Employee');

  if (!email && !password && !required) return null;
  if (!email || !password) throw new Error(`${prefix}_EMAIL and ${prefix}_PASSWORD must both be set`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`${prefix}_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return { email, password, fullName, role };
}

async function seed() {
  if (config.isProd) throw new Error('The dev seed must not run with NODE_ENV=production');

  const accounts = [
    readAccount('SEED_ADMIN', 'admin', true),
    readAccount('SEED_MANAGER', 'manager', false),
    readAccount('SEED_EMPLOYEE', 'employee', false),
  ].filter(Boolean);

  for (const account of accounts) {
    if (await users.findByEmailWithHash(account.email)) {
      logger.info('seed: user already exists, skipped', { email: account.email });
      continue;
    }
    const id = await users.create({ ...account, passwordHash: await hashPassword(account.password) });
    logger.info('seed: user created', { id, email: account.email, role: account.role });
  }
}

seed()
  .catch((err) => {
    logger.error('seed failed', { error: err.message });
    process.exitCode = 1;
  })
  .finally(() => pool.end());
