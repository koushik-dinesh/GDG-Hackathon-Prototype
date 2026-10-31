// Jira payloads -> normalized envelopes. Used by sync and webhooks alike, so both produce the same
// records and the same activity keys (an event seen twice is stored once).
//
// Records: issue (any Jira issue type; externalKey PAY-42), comment (child of its issue).
// Links: Jira issue links (blocks / duplicates / relates / clones) and sub-task parents.

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Plain text from Atlassian Document Format (descriptions and comments in API v3). */
export function adfToText(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'text') out.push(n.text ?? '');
    else if (n.type === 'hardBreak') out.push('\n');
    else if (n.type === 'mention') out.push(n.attrs?.text ?? '');
    else if (n.type === 'inlineCard') out.push(n.attrs?.url ?? '');
    for (const c of n.content ?? []) walk(c);
    if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type)) out.push('\n');
  };
  walk(node);
  const text = out.join('').replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

/** Jira's own status categories: new / indeterminate / done. */
export function statusCategoryOf(status) {
  switch (status?.statusCategory?.key) {
    case 'new':
      return 'todo';
    case 'indeterminate':
      return 'in_progress';
    case 'done':
      return 'done';
    default:
      return 'unknown';
  }
}

export const userRef = (u) => (u?.accountId ? { externalUserId: u.accountId } : null);

export function identityOf(u) {
  if (!u?.accountId) return [];
  return [{ type: 'identity', externalUserId: u.accountId, login: u.displayName ?? null, displayName: u.displayName ?? null, email: u.emailAddress || null, isBot: u.accountType === 'app' }];
}

const activity = (source, key, activityType, recordRef, actor, occurredAt, summary, details) => ({
  type: 'activity',
  dedupeKey: `jira:${source}:${key}`.slice(0, 191),
  activityType,
  recordRef,
  actorRef: userRef(actor),
  occurredAt,
  summary,
  details: details ?? null,
});

// Jira link type name -> our relationship type; `outward` direction reads "<this> blocks <other>".
const LINK_TYPE = { blocks: 'blocks', duplicate: 'duplicates', cloners: 'related', relates: 'related' };

function linkEnvelopes(issue) {
  const self = { recordType: 'issue', externalId: String(issue.id) };
  const out = [];
  for (const l of issue.fields?.issuelinks ?? []) {
    const type = LINK_TYPE[String(l.type?.name ?? '').toLowerCase()] ?? 'related';
    // Both ends report the link; emitting it from either side gives the same stored relationship.
    if (l.outwardIssue?.id) out.push({ type: 'link', fromRef: self, toRef: { recordType: 'issue', externalId: String(l.outwardIssue.id) }, linkType: type });
    if (l.inwardIssue?.id) out.push({ type: 'link', fromRef: { recordType: 'issue', externalId: String(l.inwardIssue.id) }, toRef: self, linkType: type });
  }
  // A sub-task or child issue: its parent includes it.
  if (issue.fields?.parent?.id) out.push({ type: 'link', fromRef: { recordType: 'issue', externalId: String(issue.fields.parent.id) }, toRef: self, linkType: 'includes' });
  for (const sub of issue.fields?.subtasks ?? []) if (sub?.id) out.push({ type: 'link', fromRef: self, toRef: { recordType: 'issue', externalId: String(sub.id) }, linkType: 'includes' });
  return out;
}

/** Issue record (+ people, links, its comments, a created activity). */
export function issueEnvelopes(source, siteUrl, issue, { withComments = true } = {}) {
  const f = issue.fields ?? {};
  const ref = { recordType: 'issue', externalId: String(issue.id) };
  const people = [f.reporter, f.creator, f.assignee].filter(Boolean);
  const out = [
    ...people.flatMap(identityOf),
    {
      type: 'record',
      ...ref,
      externalKey: issue.key,
      url: siteUrl ? `${siteUrl}/browse/${encodeURIComponent(issue.key)}` : null,
      title: f.summary ?? issue.key,
      body: adfToText(f.description),
      state: f.status?.name ?? null,
      statusCategory: statusCategoryOf(f.status),
      authorRef: userRef(f.reporter ?? f.creator),
      sourceCreatedAt: iso(f.created),
      sourceUpdatedAt: iso(f.updated),
      metadata: {
        key: issue.key,
        projectKey: f.project?.key ?? null,
        issueType: f.issuetype?.name ?? null,
        subtask: Boolean(f.issuetype?.subtask),
        priority: f.priority?.name ?? null,
        assignees: f.assignee?.accountId ? [{ id: f.assignee.accountId, login: f.assignee.displayName ?? null }] : [],
        labels: f.labels ?? [],
        dueDate: f.duedate ?? null,
        resolution: f.resolution?.name ?? null,
        resolvedAt: iso(f.resolutiondate),
        parentKey: f.parent?.key ?? null,
      },
    },
    activity(source, `issue:${issue.id}:created`, 'created', ref, f.reporter ?? f.creator, iso(f.created) ?? new Date().toISOString(), `${f.reporter?.displayName ?? 'someone'} created ${issue.key} ${f.summary ?? ''}`.trim()),
    ...linkEnvelopes(issue),
  ];
  if (withComments) for (const c of f.comment?.comments ?? []) out.push(...commentEnvelopes(source, siteUrl, issue, c));
  return out;
}

export function commentEnvelopes(source, siteUrl, issue, comment) {
  const ref = { recordType: 'comment', externalId: String(comment.id) };
  const key = issue.key ?? issue.fields?.key;
  return [
    ...identityOf(comment.author),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: siteUrl && key ? `${siteUrl}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(comment.id)}` : null,
      title: `Comment on ${key ?? 'issue'}`,
      body: adfToText(comment.body),
      state: null,
      statusCategory: 'unknown',
      authorRef: userRef(comment.author),
      parentRef: { recordType: 'issue', externalId: String(issue.id) },
      sourceCreatedAt: iso(comment.created),
      sourceUpdatedAt: iso(comment.updated ?? comment.created),
      metadata: { issueKey: key ?? null },
    },
    activity(source, `comment:${comment.id}:created`, 'commented', ref, comment.author, iso(comment.created) ?? new Date().toISOString(), `${comment.author?.displayName ?? 'someone'} commented on ${key ?? 'an issue'}`),
  ];
}

/** A project as an integration resource (the unit admins enable and map to a WorkAgent project). */
export const resourceOf = (siteUrl, p) => ({
  resourceType: 'project',
  externalId: String(p.id),
  name: p.key,
  url: siteUrl ? `${siteUrl}/browse/${encodeURIComponent(p.key)}` : null,
  metadata: { key: p.key, name: p.name ?? p.key, projectType: p.projectTypeKey ?? null },
});
