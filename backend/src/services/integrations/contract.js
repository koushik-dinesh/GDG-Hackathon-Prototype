// The connector contract (Phase 3A, docs/PHASE_3A_PLAN.md §5.1). Every provider module under
// providers/<id>/ default-exports an object of this shape. Connectors never touch the database:
// they call their provider and return normalized envelopes; the framework does every write.
//
// {
//   id, displayName, sourceInstance,
//   capabilities: { install: 'github_app'|'oauth2'|'api_token', webhooks, polling, credentials },
//   configProblem()                          -> null | string (why the provider is unavailable)
//   beginConnect({ state })                  -> { redirectUrl }
//   completeConnect(ctx, { params })         -> { account: { externalAccountId, login?, type?, displayName },
//                                                 settings?, credentials?: [{ kind, value, expiresAt? }] }
//   refreshCredentials?(ctx)                 -> [{ kind, value, expiresAt? }]
//   disconnect?(ctx, { uninstall })          -> void (best effort)
//   listResources(ctx)                       -> [{ resourceType, externalId, name, url?, metadata? }]
//   health(ctx)                              -> { status: 'healthy'|'degraded'|'failing', detail? }
//   polling:  streams(resource)              -> ['issues', ...]
//             syncStream(ctx, { resource, stream, cursor, phase, since })
//                                            -> { envelopes, cursor, phase, done }
//   webhooks: verifyWebhook({ headers, rawBody })   -> boolean
//             parseWebhook({ headers, body })       -> { deliveryId, eventType, action?, externalAccountId? }
//             handleWebhook(ctx, delivery)          -> { envelopes, resourceRef?: { resourceType, externalId },
//                                                        lifecycle?: { status?: 'active'|'suspended'|'disconnected',
//                                                                      refreshResources?: boolean } }
//                                                      (envelopes are only written for an enabled resourceRef)
// }
//
// ctx (built by the framework): { connection, resource?, http, credentials: { get(kind) }, logger, signal }

export const INSTALL_TYPES = ['github_app', 'oauth2', 'api_token'];
export const ENVELOPE_TYPES = ['record', 'activity', 'identity', 'link'];

const ALWAYS = ['configProblem', 'beginConnect', 'completeConnect', 'listResources', 'health'];
const POLLING = ['streams', 'syncStream'];
const WEBHOOKS = ['verifyWebhook', 'parseWebhook', 'handleWebhook'];
const OPTIONAL = ['refreshCredentials', 'disconnect'];

/** Problems with a connector module, as strings; [] when it satisfies the contract. */
export function connectorProblems(connector) {
  if (!connector || typeof connector !== 'object') return ['connector must be an object'];
  const problems = [];
  if (typeof connector.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(connector.id)) problems.push('id must match /^[a-z][a-z0-9_]{1,31}$/');
  if (typeof connector.displayName !== 'string' || !connector.displayName.trim()) problems.push('displayName is required');
  if (typeof connector.sourceInstance !== 'string' || !connector.sourceInstance.trim()) problems.push('sourceInstance is required');

  const caps = connector.capabilities;
  if (!caps || typeof caps !== 'object') {
    problems.push('capabilities is required');
  } else {
    if (!INSTALL_TYPES.includes(caps.install)) problems.push(`capabilities.install must be one of ${INSTALL_TYPES.join(', ')}`);
    for (const flag of ['webhooks', 'polling', 'credentials']) {
      if (typeof caps[flag] !== 'boolean') problems.push(`capabilities.${flag} must be a boolean`);
    }
    if (!caps.webhooks && !caps.polling) problems.push('a connector must support webhooks, polling or both');
  }

  const required = [...ALWAYS, ...(caps?.polling ? POLLING : []), ...(caps?.webhooks ? WEBHOOKS : [])];
  for (const name of required) {
    if (typeof connector[name] !== 'function') problems.push(`${name}() is required`);
  }
  for (const name of OPTIONAL) {
    if (connector[name] !== undefined && typeof connector[name] !== 'function') problems.push(`${name} must be a function when present`);
  }
  return problems;
}

/** Throws if the module does not satisfy the contract. */
export function assertConnector(connector) {
  const problems = connectorProblems(connector);
  if (problems.length) throw new Error(`Invalid connector "${connector?.id ?? '?'}": ${problems.join('; ')}`);
  return connector;
}
