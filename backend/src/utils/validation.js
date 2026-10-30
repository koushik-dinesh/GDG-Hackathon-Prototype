import { z } from 'zod';
import { isValidIsoDate } from './dates.js';

export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const idParams = z.object({ id });

export const email = z.string().trim().toLowerCase().pipe(z.email().max(255));
export const personName = z.string().trim().min(1, 'Required').max(200);
export const ROLES = ['admin', 'manager', 'employee'];
export const role = z.enum(ROLES);

// Empty string from a form clears an optional value.
export const optionalNullable = (schema) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());

export const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

// A password chosen by the user (invitation acceptance). bcrypt only uses the first 72 bytes,
// so longer values are refused rather than silently truncated.
export const newPassword = z
  .string()
  .min(12, 'Use at least 12 characters')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Use at most 72 bytes (about 72 characters)')
  .refine((v) => v.trim().length > 0, 'Password cannot be only spaces');


/** 'YYYY-MM-DD' calendar date. */
export const isoDate = z.string().refine(isValidIsoDate, 'Use a valid date (YYYY-MM-DD)');
