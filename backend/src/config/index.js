import { createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js 22 or newer is required (running ${process.version}). Run: nvm use 22`);
  process.exit(1);
}

// Load backend/.env if present. Real environment variables always win.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

// A 32-byte key written as base64 (standard or URL-safe). Generate with: openssl rand -base64 32
const encryptionKey = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || undefined)
  .refine((v) => !v || /^[A-Za-z0-9+/_-]+={0,2}$/.test(v), 'Must be base64 (generate with: openssl rand -base64 32)')
  .refine((v) => !v || Buffer.from(v, 'base64').length === 32, 'Must decode to exactly 32 bytes (openssl rand -base64 32)');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3307),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_TEST_NAME: z.string().min(1).default('meeting_action_test'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  // Leave unset to get secure cookies only in production.
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // How long an employee invitation link stays valid (default 72 h, max 30 days).
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  // Claude (AI extraction). Without a key the API refuses to queue extractions.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  ANTHROPIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(128000).default(32000),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(300_000),
  // Server-side refusal fallback (beta). Set to false to disable.
  ANTHROPIC_REFUSAL_FALLBACK: z.enum(['true', 'false']).default('true'),

  // Used to resolve relative deadlines ("tomorrow", "Friday") from the meeting date.
  MEETING_TIMEZONE: z
    .string()
    .default('UTC')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Must be an IANA timezone such as "Europe/Berlin"'),
  EXTRACTION_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().positive().default(600_000),
  EXTRACTION_OUTPUT_LANGUAGE: z.string().min(2).max(40).default('English'),

  // Email notifications (Phase 5). Unset EMAIL_PROVIDER = sending disabled.
  EMAIL_PROVIDER: z.enum(['', 'smtp', 'resend']).default(''),
  EMAIL_FROM: z.string().trim().max(320).optional(),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  // Public URL of the web app, linked from emails. Omitted from emails when unset.
  APP_PUBLIC_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'Must be an http(s) URL'),

  // Vexa meeting bot (Phase 7). Separate service; unset VEXA_BASE_URL/VEXA_API_KEY = disabled.
  VEXA_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Must be an http(s) URL'),
  VEXA_API_KEY: z.string().optional(),
  VEXA_BOT_NAME: z.string().trim().min(1).max(100).default('Meeting to Action'),
  VEXA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  VEXA_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15_000),
  // Give up polling a bot after this long (default 4 h).
  VEXA_POLL_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(4 * 60 * 60 * 1000),
  // After the meeting ends, keep checking for transcript segments for this long.
  VEXA_TRANSCRIPT_WAIT_MS: z.coerce.number().int().min(0).default(5 * 60 * 1000),
  // Queue AI extraction automatically once a Vexa transcript is saved.
  VEXA_AUTO_EXTRACT: z.enum(['true', 'false']).default('true'),

  // Integrations (Phase 3A). Encrypts stored integration credentials (OAuth/installation tokens).
  // PREVIOUS is only needed while rotating keys (see docs/PHASE_3A_PLAN.md §6).
  CREDENTIALS_ENCRYPTION_KEY: encryptionKey,
  CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: encryptionKey,
  // Registers the built-in fake provider (no network) to try the integration UI. Ignored in production.
  INTEGRATIONS_FAKE_PROVIDER: z.enum(['true', 'false']).default('false'),
  // How often each enabled resource is re-synced (reconciliation behind webhooks).
  INTEGRATION_SYNC_INTERVAL_MIN: z.coerce.number().int().min(1).max(1440).default(15),
  // First sync of a resource covers this many days (plus whatever the provider says is still open).
  INTEGRATION_BACKFILL_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // One sync job runs at most this long / this many provider requests, then yields to other jobs.
  INTEGRATION_SYNC_CHUNK_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  INTEGRATION_SYNC_CHUNK_REQUESTS: z.coerce.number().int().min(1).max(1000).default(10),
  // Pause a connection when fewer provider requests than this remain in its rate-limit window.
  INTEGRATION_RATE_LIMIT_RESERVE: z.coerce.number().int().min(0).default(200),
  // Largest webhook body accepted (GitHub sends up to 25 MB; bigger changes arrive via sync).
  WEBHOOK_MAX_BYTES: z.coerce.number().int().min(1024).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  // Webhook payloads are kept this many days (for retries and replay), then deleted.
  WEBHOOK_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // Public base URL providers send webhooks to (shown to admins), e.g. https://workagent-dev.example.com
  PUBLIC_WEBHOOK_BASE_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(v), 'Must be an http(s) URL'),

  // GitHub App (Phase 3B). Unset GITHUB_APP_ID = GitHub integration unavailable.
  GITHUB_APP_ID: z.string().regex(/^\d+$/, 'The numeric App ID from the GitHub App settings').optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/i, 'The App’s URL name (github.com/apps/<slug>)').optional(),
  // PEM text (newlines may be written as \n) or a path to the .pem file; one of the two.
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(20, 'Use a long random webhook secret (openssl rand -hex 32)').optional(),
  // Accepted as well during webhook secret rotation.
  GITHUB_WEBHOOK_SECRET_PREVIOUS: z.string().min(20).optional(),
  // Only for GitHub Enterprise Server; github.com needs no change. Must be https.
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_WEB_URL: z.string().url().default('https://github.com'),

  // Jira Cloud (OAuth 2.0 3LO app from developer.atlassian.com). Unset JIRA_CLIENT_ID = unavailable.
  JIRA_CLIENT_ID: z.string().min(10).optional(),
  JIRA_CLIENT_SECRET: z.string().min(10).optional(),
  // The one Jira site this deployment syncs, e.g. https://acme.atlassian.net
  JIRA_SITE_URL: z.string().url().optional(),
  // Secret of the webhook an admin registers in Jira (System > Webhooks); optional: without it Jira is polled only.
  JIRA_WEBHOOK_SECRET: z.string().min(20, 'Use a long random webhook secret (openssl rand -hex 32)').optional(),
  JIRA_AUTH_URL: z.string().url().default('https://auth.atlassian.com'),
  JIRA_API_URL: z.string().url().default('https://api.atlassian.com'),

  // Background worker / job queue
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(30_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(300_000),
  // Optional comma list: this worker only runs these job types (e.g. a dedicated integrations
  // worker with "integration.sync,integration.webhook"). Empty = every type.
  WORKER_JOB_TYPES: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []))
    .refine((list) => list.every((t) => /^[a-z][a-z0-9_.]{1,63}$/.test(t)), 'Comma-separated job types, e.g. integration.sync,integration.webhook'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}\nSee backend/.env.example.`);
  process.exit(1);
}

const env = parsed.data;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

if (isProd && env.JWT_SECRET.startsWith('change-me')) {
  console.error('Refusing to start in production with the example JWT_SECRET.');
  process.exit(1);
}

if (env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS && !env.CREDENTIALS_ENCRYPTION_KEY) {
  console.error('CREDENTIALS_ENCRYPTION_KEY_PREVIOUS is set without CREDENTIALS_ENCRYPTION_KEY. See backend/.env.example.');
  process.exit(1);
}

const decodeKey = (v) => (v ? Buffer.from(v, 'base64') : null);
// Tests never see the deployment's real key: each test run gets a throwaway one.
const encryptionKeys = isTest
  ? { current: randomBytes(32), previous: null }
  : { current: decodeKey(env.CREDENTIALS_ENCRYPTION_KEY), previous: decodeKey(env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS) };

if (encryptionKeys.previous?.equals(encryptionKeys.current)) {
  console.error('CREDENTIALS_ENCRYPTION_KEY_PREVIOUS must differ from CREDENTIALS_ENCRYPTION_KEY.');
  process.exit(1);
}

// GitHub App private key: PEM text (\n allowed) or a file. Validated here so a bad key fails at
// startup; error messages never include the key.
function loadGithubPrivateKey() {
  if (isTest) return undefined;
  if (env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    console.error('Set GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH, not both.');
    process.exit(1);
  }
  let pem;
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      console.error('GITHUB_APP_PRIVATE_KEY_PATH cannot be read.');
      process.exit(1);
    }
  } else if (env.GITHUB_APP_PRIVATE_KEY) {
    pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else {
    return undefined;
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    console.error('The GitHub App private key is not a valid RSA private key (PEM). Download a new one from the App settings.');
    process.exit(1);
  }
  return pem;
}
const githubPrivateKey = loadGithubPrivateKey();
if (!isTest && env.GITHUB_APP_ID && (!githubPrivateKey || !env.GITHUB_APP_SLUG || !env.GITHUB_WEBHOOK_SECRET)) {
  console.warn('GITHUB_APP_ID is set but GITHUB_APP_SLUG, the private key or GITHUB_WEBHOOK_SECRET is missing; GitHub stays unavailable.');
}
if (isProd && (!env.GITHUB_API_URL.startsWith('https://') || !env.GITHUB_WEB_URL.startsWith('https://'))) {
  console.error('GITHUB_API_URL and GITHUB_WEB_URL must be https in production.');
  process.exit(1);
}

export const config = {
  env: env.NODE_ENV,
  isProd,
  isTest,
  port: env.PORT,
  logLevel: isTest ? 'error' : env.LOG_LEVEL,
  db: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    // The test suite always runs against a separate database.
    database: isTest ? env.DB_TEST_NAME : env.DB_NAME,
  },
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
  },
  invitations: {
    ttlHours: env.INVITATION_TTL_HOURS,
  },
  cookie: {
    name: 'mta_session',
    secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  },
  ai: {
    // Never used by the test suite, which mocks Claude, so tests can't make paid calls.
    apiKey: isTest ? undefined : env.ANTHROPIC_API_KEY || undefined,
    model: env.ANTHROPIC_MODEL,
    effort: env.ANTHROPIC_EFFORT,
    maxOutputTokens: env.ANTHROPIC_MAX_OUTPUT_TOKENS,
    timeoutMs: env.ANTHROPIC_TIMEOUT_MS,
    refusalFallback: env.ANTHROPIC_REFUSAL_FALLBACK === 'true',
  },
  extraction: {
    timezone: env.MEETING_TIMEZONE,
    maxTranscriptChars: env.EXTRACTION_MAX_TRANSCRIPT_CHARS,
    outputLanguage: env.EXTRACTION_OUTPUT_LANGUAGE,
  },
  email: {
    // The test suite never uses a real provider (tests inject a fake one).
    provider: isTest ? '' : env.EMAIL_PROVIDER,
    from: env.EMAIL_FROM || undefined,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    },
    resendApiKey: isTest ? undefined : env.RESEND_API_KEY || undefined,
    maxAttempts: env.EMAIL_MAX_ATTEMPTS,
    appPublicUrl: env.APP_PUBLIC_URL ? env.APP_PUBLIC_URL.replace(/\/+$/, '') : undefined,
  },
  vexa: {
    // Tests set their own fake endpoint and never reach a real Vexa.
    baseUrl: isTest ? undefined : env.VEXA_BASE_URL ? env.VEXA_BASE_URL.replace(/\/+$/, '') : undefined,
    apiKey: isTest ? undefined : env.VEXA_API_KEY || undefined,
    botName: env.VEXA_BOT_NAME,
    requestTimeoutMs: env.VEXA_REQUEST_TIMEOUT_MS,
    pollIntervalMs: env.VEXA_POLL_INTERVAL_MS,
    pollTimeoutMs: env.VEXA_POLL_TIMEOUT_MS,
    transcriptWaitMs: env.VEXA_TRANSCRIPT_WAIT_MS,
    autoExtract: env.VEXA_AUTO_EXTRACT === 'true',
  },
  integrations: {
    // Buffers (or null). Only services/integrations/crypto.js reads these.
    encryptionKeys,
    // Always on in tests; never in production.
    fakeProvider: isTest || (!isProd && env.INTEGRATIONS_FAKE_PROVIDER === 'true'),
    syncIntervalMs: env.INTEGRATION_SYNC_INTERVAL_MIN * 60_000,
    backfillDays: env.INTEGRATION_BACKFILL_DAYS,
    chunkBudget: { ms: env.INTEGRATION_SYNC_CHUNK_MS, requests: env.INTEGRATION_SYNC_CHUNK_REQUESTS },
    rateLimitReserve: env.INTEGRATION_RATE_LIMIT_RESERVE,
    webhookMaxBytes: env.WEBHOOK_MAX_BYTES,
    webhookRetentionDays: env.WEBHOOK_PAYLOAD_RETENTION_DAYS,
    publicWebhookBaseUrl: env.PUBLIC_WEBHOOK_BASE_URL ? env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/+$/, '') : undefined,
  },
  // GitHub App (Phase 3B). Tests never see real values: they configure a fake GitHub explicitly.
  github: isTest
    ? { appId: undefined, slug: undefined, privateKey: undefined, webhookSecrets: [], apiUrl: env.GITHUB_API_URL, webUrl: env.GITHUB_WEB_URL }
    : {
        appId: env.GITHUB_APP_ID,
        slug: env.GITHUB_APP_SLUG,
        privateKey: githubPrivateKey,
        webhookSecrets: [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_PREVIOUS].filter(Boolean),
        apiUrl: env.GITHUB_API_URL.replace(/\/+$/, ''),
        webUrl: env.GITHUB_WEB_URL.replace(/\/+$/, ''),
      },
  // Jira Cloud. Tests configure a fake Jira explicitly and never see real values.
  jira: isTest
    ? { clientId: undefined, clientSecret: undefined, siteUrl: undefined, webhookSecret: undefined, authUrl: env.JIRA_AUTH_URL, apiUrl: env.JIRA_API_URL }
    : {
        clientId: env.JIRA_CLIENT_ID,
        clientSecret: env.JIRA_CLIENT_SECRET,
        siteUrl: env.JIRA_SITE_URL?.replace(/\/+$/, ''),
        webhookSecret: env.JIRA_WEBHOOK_SECRET,
        authUrl: env.JIRA_AUTH_URL.replace(/\/+$/, ''),
        apiUrl: env.JIRA_API_URL.replace(/\/+$/, ''),
      },
  jobs: {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    backoffBaseMs: env.JOB_BACKOFF_BASE_MS,
    staleAfterMs: env.JOB_STALE_AFTER_MS,
    workerTypes: env.WORKER_JOB_TYPES,
  },
};
