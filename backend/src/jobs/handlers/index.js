import { aiExtract } from './aiExtract.js';
import { correlationEvaluate } from './correlationEvaluate.js';
import { emailSend } from './emailSend.js';
import { integrationMaintenance } from './integrationMaintenance.js';
import { integrationSync } from './integrationSync.js';
import { integrationWebhook } from './integrationWebhook.js';
import { vexaPoll } from './vexaPoll.js';

// Job type -> handler. (Transcript fetching is part of 'vexa.poll'.)
export const handlers = {
  'ai.extract': aiExtract,
  'email.send': emailSend,
  'vexa.poll': vexaPoll,
  'integration.sync': integrationSync,
  'integration.webhook': integrationWebhook,
  'integration.maintenance': integrationMaintenance,
  'correlation.evaluate': correlationEvaluate,
};

/** The handlers this worker runs: all, or only those listed in WORKER_JOB_TYPES. */
export function handlersFor(types) {
  if (!types?.length) return handlers;
  const unknown = types.filter((t) => !handlers[t]);
  if (unknown.length) throw new Error(`WORKER_JOB_TYPES lists unknown job types: ${unknown.join(', ')}`);
  return Object.fromEntries(types.map((t) => [t, handlers[t]]));
}
