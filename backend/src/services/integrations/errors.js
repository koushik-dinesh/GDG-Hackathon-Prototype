// Error taxonomy for connectors (Phase 3A, docs/PHASE_3A_PLAN.md §5.2). Connectors throw
// ProviderError with one of these kinds; the framework maps each kind to a job outcome and to the
// connection's health. Messages must never contain credentials or provider response bodies.

export const PROVIDER_ERROR_KINDS = {
  rate_limited: { retryable: true, publicMessage: 'The provider is rate limiting requests; syncing resumes automatically' },
  transient: { retryable: true, publicMessage: 'The provider is temporarily unavailable' },
  auth: { retryable: false, publicMessage: 'The provider rejected the credentials; reconnect the integration' },
  forbidden: { retryable: false, publicMessage: 'The integration is missing a permission it needs' },
  not_found: { retryable: false, publicMessage: 'The provider no longer has this resource' },
  invalid_request: { retryable: false, publicMessage: 'The provider rejected the request' },
  invalid_response: { retryable: false, publicMessage: 'The provider returned an unexpected response' },
  suspended: { retryable: false, publicMessage: 'The integration is suspended at the provider' },
};

export class ProviderError extends Error {
  /**
   * @param {keyof PROVIDER_ERROR_KINDS} kind
   * @param {string} message internal, sanitized (no secrets or bodies)
   * @param {{ status?: number, resetAt?: Date, retryAfterMs?: number, publicMessage?: string, cause?: unknown }} [details]
   */
  constructor(kind, message, { status, resetAt, retryAfterMs, publicMessage, cause } = {}) {
    if (!PROVIDER_ERROR_KINDS[kind]) throw new Error(`Unknown provider error kind: ${kind}`);
    super(message, { cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.resetAt = resetAt;
    this.retryAfterMs = retryAfterMs;
    // Read by the job queue: false stops retries.
    this.retryable = PROVIDER_ERROR_KINDS[kind].retryable;
    this.publicMessage = publicMessage ?? PROVIDER_ERROR_KINDS[kind].publicMessage;
  }

  /** Milliseconds to wait before trying again, for rate limits. */
  waitMs(now = Date.now()) {
    if (this.resetAt) return Math.max(0, this.resetAt.getTime() - now);
    return this.retryAfterMs ?? 60_000;
  }
}

export const isProviderError = (err) => err instanceof ProviderError;
