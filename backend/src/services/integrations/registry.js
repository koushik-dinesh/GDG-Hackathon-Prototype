// Provider registry (Phase 3A). Providers are code (providers/<id>/), validated against the
// connector contract at startup. A provider is "available" when its own configuration is complete
// and, if it stores credentials, the encryption key is set. Connections are rows in the database.
import { config } from '../../config/index.js';
import { assertConnector } from './contract.js';
import { keyring } from './crypto.js';
import fake from './providers/fake/index.js';
import github from './providers/github/index.js';
import figma from './providers/figma/index.js';
import googleMeet from './providers/google/meet.js';
import jira from './providers/jira/index.js';
import outlook from './providers/microsoft/outlook.js';
import microsoftTeams from './providers/microsoft/teams.js';

export function createRegistry(connectors, { keyConfigured = () => keyring.isConfigured() } = {}) {
  const byId = new Map();
  for (const c of connectors) {
    assertConnector(c);
    if (byId.has(c.id)) throw new Error(`Duplicate connector id "${c.id}"`);
    byId.set(c.id, c);
  }

  /** Why the provider can't be used right now, or null. */
  function problem(c) {
    const own = c.configProblem();
    if (own) return own;
    if (c.capabilities.credentials && !keyConfigured()) return 'CREDENTIALS_ENCRYPTION_KEY is not set';
    return null;
  }

  return {
    /** The connector, or null when unknown. */
    get: (id) => byId.get(id) ?? null,
    /** The connector if it exists and is available, else null. */
    getAvailable(id) {
      const c = byId.get(id);
      return c && !problem(c) ? c : null;
    },
    problem: (id) => (byId.has(id) ? problem(byId.get(id)) : 'Unknown provider'),
    /** Public description of every registered provider (no configuration values). */
    list: () =>
      [...byId.values()].map((c) => {
        const p = problem(c);
        return { id: c.id, displayName: c.displayName, capabilities: { ...c.capabilities }, available: !p, problem: p };
      }),
  };
}

// Real providers are always registered and become available once configured (GitHub: Phase 3B).
// The fake provider exists for tests and, with INTEGRATIONS_FAKE_PROVIDER=true outside
// production, for trying the UI.
export const registry = createRegistry([github, jira, microsoftTeams, outlook, googleMeet, figma, ...(config.integrations.fakeProvider ? [fake] : [])]);
