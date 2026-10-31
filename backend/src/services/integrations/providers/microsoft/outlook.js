// Outlook connector: the connected account's mail folders and calendars through Microsoft Graph.
//
// Resources: mail folders (resourceType mail_folder) and calendars (calendar). Nothing syncs until
// an admin enables one and maps it to a project.
// Records:
//   email           subject, sender, recipients, the 255-character preview Graph provides — never
//                   the full body or attachments (privacy; the preview is enough for matching)
//   calendar_event  subject, start/end, organizer, attendee count, online meeting link, preview
// Sync: Graph delta queries (messages per folder; calendarView per calendar from the backfill
// window to 60 days ahead), deletions included.
import { ProviderError } from '../../errors.js';
import { beginMicrosoftConnect, completeMicrosoftConnect, deltaPage, graphClient, listAll, microsoftConfigProblem, refreshMicrosoftTokens, tenantInstance } from './graph.js';

export const OUTLOOK_SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'];
const FUTURE_DAYS = 60;
const MAIL_SELECT = 'subject,from,toRecipients,ccRecipients,receivedDateTime,lastModifiedDateTime,bodyPreview,webLink,conversationId,importance,categories,isDraft';
const EVENT_SELECT = 'subject,bodyPreview,start,end,organizer,attendees,isCancelled,isOnlineMeeting,onlineMeeting,webLink,location,createdDateTime,lastModifiedDateTime,seriesMasterId,type';

const addr = (r) => r?.emailAddress?.address?.toLowerCase() ?? null;
// People in mail are e-mail addresses: the identity is the address (matched to users by e-mail).
const identityOf = (r) => (addr(r) ? [{ type: 'identity', externalUserId: addr(r), login: addr(r), displayName: r.emailAddress.name ?? null, email: addr(r), isBot: false }] : []);
const ref = (r) => (addr(r) ? { externalUserId: addr(r) } : null);

export function emailEnvelopes(source, folderId, m) {
  const recordRef = { recordType: 'email', externalId: m.id };
  if (m['@removed']) return [{ type: 'record', ...recordRef, title: null, body: null, deleted: true }];
  if (m.isDraft) return [];
  return [
    ...identityOf(m.from),
    {
      type: 'record',
      ...recordRef,
      externalKey: null,
      url: m.webLink ?? null,
      title: m.subject || '(no subject)',
      body: m.bodyPreview || null,
      state: null,
      statusCategory: 'unknown',
      authorRef: ref(m.from),
      sourceCreatedAt: m.receivedDateTime ?? null,
      sourceUpdatedAt: m.lastModifiedDateTime ?? m.receivedDateTime ?? null,
      metadata: {
        folderId,
        conversationId: m.conversationId ?? null,
        from: addr(m.from),
        to: (m.toRecipients ?? []).map(addr).filter(Boolean).slice(0, 50),
        cc: (m.ccRecipients ?? []).map(addr).filter(Boolean).slice(0, 50),
        importance: m.importance ?? null,
        categories: m.categories ?? [],
        bodyStored: 'preview',
      },
    },
    {
      type: 'activity',
      dedupeKey: `outlook:${source}:email:${m.id}:received`.slice(0, 191),
      activityType: 'created',
      recordRef,
      actorRef: ref(m.from),
      occurredAt: m.receivedDateTime ?? new Date().toISOString(),
      summary: `${m.from?.emailAddress?.name ?? addr(m.from) ?? 'someone'} e-mailed “${m.subject || '(no subject)'}”`,
    },
  ];
}

const graphTime = (t) => (t?.dateTime ? new Date(`${t.dateTime.replace(/Z$/, '')}${t.timeZone === 'UTC' || !t.timeZone ? 'Z' : ''}`).toISOString() : null);

export function eventEnvelopes(source, calendarId, ev, now = new Date()) {
  const recordRef = { recordType: 'calendar_event', externalId: ev.id };
  if (ev['@removed']) return [{ type: 'record', ...recordRef, title: null, body: null, deleted: true }];
  const start = graphTime(ev.start);
  const end = graphTime(ev.end);
  const category = ev.isCancelled ? 'cancelled' : end && new Date(end) < now ? 'done' : 'todo';
  return [
    ...identityOf(ev.organizer),
    {
      type: 'record',
      ...recordRef,
      externalKey: null,
      url: ev.webLink ?? null,
      title: ev.subject || '(no title)',
      body: ev.bodyPreview || null,
      state: ev.isCancelled ? 'cancelled' : 'scheduled',
      statusCategory: category,
      authorRef: ref(ev.organizer),
      sourceCreatedAt: ev.createdDateTime ?? null,
      sourceUpdatedAt: ev.lastModifiedDateTime ?? null,
      metadata: {
        calendarId,
        start,
        end,
        organizer: addr(ev.organizer),
        attendees: (ev.attendees ?? []).length,
        attendeeEmails: (ev.attendees ?? []).map(addr).filter(Boolean).slice(0, 100),
        isOnlineMeeting: Boolean(ev.isOnlineMeeting),
        joinUrl: ev.onlineMeeting?.joinUrl ?? null,
        location: ev.location?.displayName || null,
        recurring: ev.type === 'occurrence' || Boolean(ev.seriesMasterId),
      },
    },
    {
      type: 'activity',
      dedupeKey: `outlook:${source}:event:${ev.id}:scheduled`.slice(0, 191),
      activityType: 'scheduled',
      recordRef,
      actorRef: ref(ev.organizer),
      occurredAt: ev.createdDateTime ?? start ?? new Date().toISOString(),
      summary: `${ev.organizer?.emailAddress?.name ?? 'someone'} scheduled “${ev.subject || '(no title)'}”${start ? ` for ${start.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    },
  ];
}

async function syncResource(ctx, { resource, stream, cursor, phase, since }) {
  const api = graphClient(ctx);
  const source = tenantInstance();
  const id = encodeURIComponent(resource.externalId);
  const from = since ? new Date(since) : new Date(Date.now() - 30 * 86_400_000);
  if (stream === 'messages') {
    const page = await deltaPage(api, cursor, {
      path: `/v1.0/me/mailFolders/${id}/messages/delta`,
      query: { $select: MAIL_SELECT, $filter: `receivedDateTime ge ${from.toISOString()}` },
    });
    const envelopes = page.items.flatMap((m) => emailEnvelopes(source, resource.externalId, m));
    return { envelopes, cursor: page.cursor, phase: page.done ? 'incremental' : phase, done: page.done };
  }
  if (stream === 'events') {
    const until = new Date(Date.now() + FUTURE_DAYS * 86_400_000);
    const page = await deltaPage(api, cursor, {
      path: `/v1.0/me/calendars/${id}/calendarView/delta`,
      query: { startDateTime: from.toISOString(), endDateTime: until.toISOString(), $select: EVENT_SELECT },
    });
    const envelopes = page.items.flatMap((ev) => eventEnvelopes(source, resource.externalId, ev));
    return { envelopes, cursor: page.cursor, phase: page.done ? 'incremental' : phase, done: page.done };
  }
  throw new ProviderError('invalid_request', `Unknown Outlook stream ${stream}`);
}

export const outlook = {
  id: 'outlook',
  displayName: 'Outlook',
  get sourceInstance() {
    return tenantInstance();
  },
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: true },
  configProblem: microsoftConfigProblem,
  beginConnect: ({ state }) => beginMicrosoftConnect('outlook', OUTLOOK_SCOPES, state),
  completeConnect: (ctx, { params }) => completeMicrosoftConnect(ctx, { providerId: 'outlook', params, scopes: OUTLOOK_SCOPES, label: 'Outlook' }),
  refreshCredentials: (ctx) => refreshMicrosoftTokens(ctx, OUTLOOK_SCOPES),
  async disconnect() {},

  async listResources(ctx) {
    const api = graphClient(ctx);
    const folders = await listAll(api, '/v1.0/me/mailFolders', { $top: 100, $select: 'id,displayName,totalItemCount' });
    const calendars = await listAll(api, '/v1.0/me/calendars', { $select: 'id,name,isDefaultCalendar,canEdit' });
    return [
      ...folders.map((f) => ({ resourceType: 'mail_folder', externalId: f.id, name: `Mail: ${f.displayName}`.slice(0, 255), metadata: { items: f.totalItemCount ?? null } })),
      ...calendars.map((c) => ({ resourceType: 'calendar', externalId: c.id, name: `Calendar: ${c.name}`.slice(0, 255), metadata: { default: Boolean(c.isDefaultCalendar) } })),
    ];
  },

  async health(ctx) {
    await graphClient(ctx).get('/v1.0/me', { query: { $select: 'id' } });
    return { status: 'healthy' };
  },

  streams: (resource) => (resource.resourceType === 'calendar' ? ['events'] : ['messages']),
  syncStream: (ctx, args) => syncResource(ctx, args),
};

export default outlook;
