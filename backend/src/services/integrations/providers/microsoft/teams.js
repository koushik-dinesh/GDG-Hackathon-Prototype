// Microsoft Teams connector: channel conversations through Microsoft Graph (delegated).
//
// Resources: the channels of the teams the connected account belongs to (one per channel).
// Records: message (a channel post; title = subject or its first words) and its replies (children).
// Sync: channel messages delta (top-level posts, edits and deletions), then the replies of every
// post seen in that run. Mentions such as PAY-42 or acme/api#12 feed relationship suggestions.
import { ProviderError } from '../../errors.js';
import { beginMicrosoftConnect, completeMicrosoftConnect, deltaPage, graphClient, htmlToText, listAll, microsoftConfigProblem, refreshMicrosoftTokens, tenantInstance } from './graph.js';

export const TEAMS_SCOPES = ['offline_access', 'User.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All'];
const REPLY_POSTS_PER_CHUNK = 5;

const identityOf = (from) => {
  const u = from?.user;
  return u?.id ? [{ type: 'identity', externalUserId: u.id, login: u.displayName ?? null, displayName: u.displayName ?? null, isBot: false }] : from?.application?.id ? [{ type: 'identity', externalUserId: from.application.id, login: from.application.displayName ?? null, displayName: from.application.displayName ?? null, isBot: true }] : [];
};
const authorRef = (from) => (from?.user?.id ? { externalUserId: from.user.id } : from?.application?.id ? { externalUserId: from.application.id } : null);
const titleOf = (m, text) => m.subject || (text ? (text.length > 80 ? `${text.slice(0, 77)}…` : text) : 'Message');

/** Envelopes for a channel post or a reply (`parent` = the post's message id). */
export function messageEnvelopes(source, channelId, m, parent = null) {
  // Message ids are unique within a channel; the record id carries the channel.
  const ref = { recordType: 'message', externalId: `${channelId}/${m.id}` };
  if (m['@removed'] || m.deletedDateTime) {
    // A tombstone: ingest marks the stored message deleted and keeps its content.
    return [{ type: 'record', ...ref, title: null, body: null, deleted: true, sourceUpdatedAt: m.deletedDateTime ?? m.lastModifiedDateTime ?? null }];
  }
  if (m.messageType && m.messageType !== 'message') return []; // system events (member added, …)
  const text = htmlToText(m.body?.contentType === 'html' ? m.body.content : m.body?.content);
  const who = m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'someone';
  return [
    ...identityOf(m.from),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: m.webUrl ?? null,
      title: titleOf(m, text),
      body: text,
      state: null,
      statusCategory: 'unknown',
      authorRef: authorRef(m.from),
      parentRef: parent ? { recordType: 'message', externalId: `${channelId}/${parent}` } : null,
      sourceCreatedAt: m.createdDateTime ?? null,
      sourceUpdatedAt: m.lastEditedDateTime ?? m.lastModifiedDateTime ?? m.createdDateTime ?? null,
      metadata: { importance: m.importance ?? null, mentions: (m.mentions ?? []).map((x) => x.mentioned?.user?.displayName).filter(Boolean), replyTo: parent },
    },
    {
      type: 'activity',
      dedupeKey: `microsoft_teams:${source}:message:${channelId}/${m.id}:created`.slice(0, 191),
      activityType: parent ? 'commented' : 'created',
      recordRef: ref,
      actorRef: authorRef(m.from),
      occurredAt: m.createdDateTime ?? new Date().toISOString(),
      summary: parent ? `${who} replied in a Teams thread` : `${who} posted “${titleOf(m, text)}” in Teams`,
    },
  ];
}

async function syncMessages(ctx, { resource, cursor, phase, since }) {
  const api = graphClient(ctx);
  const { teamId, channelId } = resource.metadata ?? {};
  if (!teamId || !channelId) throw new ProviderError('invalid_request', 'Teams channel resource without ids');
  const base = `/v1.0/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`;
  let c = { pendingReplies: [], ...(cursor ?? {}) };
  const source = tenantInstance();

  if (c.pendingReplies.length) {
    const batch = c.pendingReplies.slice(0, REPLY_POSTS_PER_CHUNK);
    const envelopes = [];
    for (const postId of batch) {
      try {
        const replies = await listAll(api, `${base}/messages/${encodeURIComponent(postId)}/replies`, { $top: 50 }, 10);
        for (const r of replies) envelopes.push(...messageEnvelopes(source, channelId, r, postId));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err;
      }
    }
    const pendingReplies = c.pendingReplies.slice(batch.length);
    if (!pendingReplies.length && c.listed) return { envelopes, cursor: { next: null, delta: c.delta, pendingReplies: [] }, phase: 'incremental', done: true };
    return { envelopes, cursor: { ...c, pendingReplies }, phase, done: false };
  }

  const filter = !c.delta && since ? { $filter: `lastModifiedDateTime gt ${new Date(since).toISOString()}` } : undefined;
  const page = await deltaPage(api, c, { path: `${base}/messages/delta`, query: { $top: 50, ...(filter ?? {}) } });
  const envelopes = page.items.flatMap((m) => messageEnvelopes(source, channelId, m));
  const posts = page.items.filter((m) => !m['@removed'] && !m.deletedDateTime && (!m.messageType || m.messageType === 'message')).map((m) => m.id);
  const pendingReplies = [...new Set([...c.pendingReplies, ...posts])];
  if (!page.done) return { envelopes, cursor: { ...page.cursor, pendingReplies }, phase, done: false };
  if (pendingReplies.length) return { envelopes, cursor: { ...page.cursor, pendingReplies, listed: true }, phase, done: false };
  return { envelopes, cursor: { ...page.cursor, pendingReplies: [] }, phase: 'incremental', done: true };
}

export const microsoftTeams = {
  id: 'microsoft_teams',
  displayName: 'Microsoft Teams',
  get sourceInstance() {
    return tenantInstance();
  },
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: true },
  configProblem: microsoftConfigProblem,
  beginConnect: ({ state }) => beginMicrosoftConnect('microsoft_teams', TEAMS_SCOPES, state),
  completeConnect: (ctx, { params }) => completeMicrosoftConnect(ctx, { providerId: 'microsoft_teams', params, scopes: TEAMS_SCOPES, label: 'Teams' }),
  refreshCredentials: (ctx) => refreshMicrosoftTokens(ctx, TEAMS_SCOPES),
  async disconnect() {
    // Delegated grants are revoked in Entra (Enterprise applications) or by the user at myaccount.microsoft.com.
  },

  async listResources(ctx) {
    const api = graphClient(ctx);
    const teams = await listAll(api, '/v1.0/me/joinedTeams', { $select: 'id,displayName' });
    const out = [];
    for (const t of teams) {
      const channels = await listAll(api, `/v1.0/teams/${encodeURIComponent(t.id)}/channels`, { $select: 'id,displayName,membershipType,webUrl' });
      for (const ch of channels) {
        out.push({
          resourceType: 'channel',
          externalId: `${t.id}/${ch.id}`.slice(0, 191),
          name: `${t.displayName} / ${ch.displayName}`.slice(0, 255),
          url: ch.webUrl ?? null,
          metadata: { teamId: t.id, channelId: ch.id, team: t.displayName, channel: ch.displayName, membershipType: ch.membershipType ?? 'standard' },
        });
      }
    }
    return out;
  },

  async health(ctx) {
    await graphClient(ctx).get('/v1.0/me', { query: { $select: 'id' } });
    return { status: 'healthy' };
  },

  streams: () => ['messages'],
  syncStream(ctx, args) {
    if (args.stream !== 'messages') throw new ProviderError('invalid_request', `Unknown Teams stream ${args.stream}`);
    return syncMessages(ctx, args);
  },
};

export default microsoftTeams;
