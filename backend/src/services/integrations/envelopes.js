// Normalized envelopes (docs/PHASE_3A_PLAN.md §5.1): what connectors return from syncStream() and
// handleWebhook(). The framework validates every envelope here before anything is written. Source
// content is untrusted: lengths are bounded, long text is truncated, and only http(s) URLs pass.
import { z } from 'zod';
import { ACTIVITY_TYPE_NAMES } from '../activities/types.js';

export const BODY_MAX_CHARS = 60_000;
export const STATUS_CATEGORIES = ['todo', 'in_progress', 'done', 'cancelled', 'unknown'];
export const LINK_TYPES = ['references', 'implements', 'fixes', 'duplicates', 'same_as', 'blocks', 'depends_on', 'discussed_in', 'related', 'includes', 'tracks'];

const typeName = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const externalId = z.coerce.string().min(1).max(191);
const truncated = (max) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ? v.slice(0, max) : null));
const date = z.union([z.date(), z.string(), z.number()]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'Invalid date' });
    return z.NEVER;
  }
  return d;
});
// Rendered as links in the UI later: never javascript:, data: or other schemes.
const httpUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      return ['http:', 'https:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, 'Only http(s) URLs are allowed')
  .nullish();
const metadata = z
  .record(z.string(), z.unknown())
  .nullish()
  .refine((v) => !v || JSON.stringify(v).length <= 32_768, 'metadata is too large');

const recordRef = z.object({ recordType: typeName, externalId });
const userRef = z.object({ externalUserId: externalId });

export const identityEnvelope = z.object({
  type: z.literal('identity'),
  externalUserId: externalId,
  login: truncated(191),
  displayName: truncated(200),
  email: z.string().max(255).pipe(z.email()).nullish(),
  isBot: z.boolean().default(false),
});

export const recordEnvelope = z.object({
  type: z.literal('record'),
  recordType: typeName,
  externalId,
  externalKey: truncated(191),
  url: httpUrl,
  title: truncated(500),
  body: z
    .string()
    .nullish()
    .transform((v) => (v ? { text: v.slice(0, BODY_MAX_CHARS), truncated: v.length > BODY_MAX_CHARS } : { text: null, truncated: false })),
  state: truncated(32),
  statusCategory: z.enum(STATUS_CATEGORIES).default('unknown'),
  authorRef: userRef.nullish(),
  parentRef: recordRef.nullish(),
  sourceCreatedAt: date.nullish(),
  sourceUpdatedAt: date.nullish(),
  deleted: z.boolean().default(false),
  metadata,
});

export const activityEnvelope = z.object({
  type: z.literal('activity'),
  dedupeKey: z.string().min(1).max(191),
  // The shared vocabulary (services/activities/types.js): one meaning per verb across providers.
  activityType: z.enum(ACTIVITY_TYPE_NAMES),
  recordRef,
  actorRef: userRef.nullish(),
  occurredAt: date,
  summary: z
    .string()
    .min(1)
    .transform((v) => v.slice(0, 500)),
  details: metadata,
});

export const linkEnvelope = z.object({
  type: z.literal('link'),
  fromRef: recordRef,
  toRef: recordRef,
  linkType: z.enum(LINK_TYPES),
});

export const envelope = z.discriminatedUnion('type', [identityEnvelope, recordEnvelope, activityEnvelope, linkEnvelope]);
export const envelopes = z.array(envelope).max(5000);

/** Parses a connector's envelopes; throws a ZodError naming the first bad envelope. */
export const parseEnvelopes = (value) => envelopes.parse(value);
