import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node.js 22 or newer is required (running ${process.version}). Run: nvm use 22`);
  process.exit(1);
}

// Load backend/.env if present. Real environment variables always win.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

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

  // Background worker / job queue
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(30_000),
  JOB_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(300_000),
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
  jobs: {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    backoffBaseMs: env.JOB_BACKOFF_BASE_MS,
    staleAfterMs: env.JOB_STALE_AFTER_MS,
  },
};
