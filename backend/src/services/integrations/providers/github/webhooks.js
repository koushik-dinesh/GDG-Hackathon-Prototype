// GitHub webhooks (Phase 3B).
// - verify: HMAC-SHA256 of the raw body with the webhook secret (X-Hub-Signature-256: sha256=...),
//   constant-time compare; the previous secret is also accepted during rotation.
// - parse: delivery id, event, action, installation id; deliveries addressed to another GitHub App
//   are refused.
// - handle: payload -> envelopes (same mappers and activity keys as sync) and lifecycle changes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../../errors.js';
import { commentEnvelopes, commitEnvelopes, issueEnvelopes, pullEnvelopes, repositoryEnvelopes, reviewCommentEnvelopes, reviewEnvelopes } from './mappers.js';
import { settings } from './settings.js';

export const SUPPORTED_EVENTS = [
  'installation',
  'installation_repositories',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'repository',
  'ping',
];

const header = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : null;
  return Array.isArray(v) ? v[0] : v;
};

export function signatureFor(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifyWebhook({ headers, rawBody }) {
  const given = header(headers, 'x-hub-signature-256');
  if (typeof given !== 'string' || !given.startsWith('sha256=') || !Buffer.isBuffer(rawBody)) return false;
  const actual = Buffer.from(given);
  let ok = false;
  // Check every configured secret (no early exit) so timing doesn't reveal which one matched.
  for (const secret of settings.webhookSecrets ?? []) {
    const expected = Buffer.from(signatureFor(secret, rawBody));
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) ok = true;
  }
  return ok;
}

export function parseWebhook({ headers, body }) {
  const deliveryId = header(headers, 'x-github-delivery');
  const eventType = header(headers, 'x-github-event');
  if (!deliveryId || !eventType) throw new ProviderError('invalid_request', 'Missing X-GitHub-Delivery or X-GitHub-Event');
  const targetType = header(headers, 'x-github-hook-installation-target-type');
  const targetId = header(headers, 'x-github-hook-installation-target-id');
  if (targetType === 'integration' && targetId && String(targetId) !== String(settings.appId)) {
    throw new ProviderError('invalid_request', 'Webhook is for another GitHub App');
  }
  return {
    deliveryId: String(deliveryId),
    eventType: String(eventType),
    action: typeof body?.action === 'string' ? body.action : null,
    externalAccountId: body?.installation?.id !== undefined ? String(body.installation.id) : null,
  };
}

function need(value, what) {
  if (value === null || value === undefined || (typeof value === 'object' && !Object.keys(value).length)) {
    throw new ProviderError('invalid_request', `GitHub payload is missing ${what}`);
  }
  return value;
}

const resourceRefOf = (repo) => ({ resourceType: 'repository', externalId: String(repo.id) });
const ACTIVITY_SOURCE_OF = (source) => source;

/**
 * Activities only webhooks can see (sync cannot reconstruct them). Keys include what makes the
 * event unique, so a redelivery maps to the same activity.
 */
function webhookActivity(source, { key, type, recordRef, actor, at, summary, details }) {
  return {
    type: 'activity',
    dedupeKey: `${ACTIVITY_SOURCE_OF(source)}:${key}`,
    activityType: type,
    recordRef,
    actorRef: actor?.id !== undefined ? { externalUserId: String(actor.id) } : null,
    occurredAt: at,
    summary,
    details: details ?? null,
  };
}

const ms = (iso) => Date.parse(iso);

export function handleWebhook(source, { eventType, action, payload }) {
  const p = payload ?? {};
  switch (eventType) {
    case 'ping':
      return { envelopes: [] };

    case 'installation': {
      const status = { deleted: 'disconnected', suspend: 'suspended', unsuspend: 'active' }[action];
      return { envelopes: [], lifecycle: { status, refreshResources: action === 'new_permissions_accepted' || action === 'unsuspend' } };
    }

    case 'installation_repositories':
      return { envelopes: [], lifecycle: { refreshResources: true } };

    case 'repository': {
      const repo = need(p.repository, 'repository');
      const refresh = ['renamed', 'transferred', 'archived', 'unarchived', 'deleted', 'privatized', 'publicized', 'edited'].includes(action);
      const deleted = action === 'deleted';
      return {
        envelopes: deleted ? [] : repositoryEnvelopes(source, repo),
        resourceRef: resourceRefOf(repo),
        lifecycle: { refreshResources: refresh },
      };
    }

    case 'issues': {
      const repo = need(p.repository, 'repository');
      const issue = need(p.issue, 'issue');
      const envelopes = issueEnvelopes(source, repo, issue);
      const record = envelopes.find((e) => e.type === 'record');
      if (action === 'deleted') record.deleted = true;
      const ref = { recordType: 'issue', externalId: record.externalId };
      if (action === 'reopened') {
        envelopes.push(webhookActivity(source, { key: `issue:${record.externalId}:reopened:${ms(issue.updated_at)}`, type: 'reopened', recordRef: ref, actor: p.sender, at: issue.updated_at, summary: `${p.sender?.login ?? 'someone'} reopened ${record.externalKey}` }));
      } else if (['assigned', 'unassigned'].includes(action) && p.assignee) {
        envelopes.push(webhookActivity(source, { key: `issue:${record.externalId}:${action}:${p.assignee.id}:${ms(issue.updated_at)}`, type: action === 'assigned' ? 'assigned' : 'unassigned', recordRef: ref, actor: p.sender, at: issue.updated_at, summary: `${p.sender?.login ?? 'someone'} ${action} ${p.assignee.login} on ${record.externalKey}`, details: { assignee: p.assignee.login } }));
      } else if (['edited', 'labeled', 'unlabeled', 'milestoned', 'demilestoned'].includes(action)) {
        envelopes.push(webhookActivity(source, { key: `issue:${record.externalId}:updated:${ms(issue.updated_at)}`, type: 'updated', recordRef: ref, actor: p.sender, at: issue.updated_at, summary: `${p.sender?.login ?? 'someone'} updated ${record.externalKey} (${action})`, details: { action } }));
      }
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    case 'issue_comment': {
      const repo = need(p.repository, 'repository');
      const comment = need(p.comment, 'comment');
      const envelopes = commentEnvelopes(source, repo, comment, need(p.issue, 'issue'));
      if (action === 'deleted') envelopes.find((e) => e.type === 'record').deleted = true;
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    case 'pull_request': {
      const repo = need(p.repository, 'repository');
      const pr = need(p.pull_request, 'pull_request');
      const envelopes = pullEnvelopes(source, repo, pr);
      const record = envelopes.find((e) => e.type === 'record');
      const ref = { recordType: 'pull_request', externalId: record.externalId };
      const extra = {
        reopened: () => ({ key: `reopened:${ms(pr.updated_at)}`, type: 'reopened', summary: 'reopened' }),
        synchronize: () => ({ key: `pushed:${p.after ?? ms(pr.updated_at)}`, type: 'pushed', summary: 'pushed new commits to', details: { headSha: p.after ?? null } }),
        ready_for_review: () => ({ key: `ready:${ms(pr.updated_at)}`, type: 'ready_for_review', summary: 'marked ready for review' }),
        converted_to_draft: () => ({ key: `draft:${ms(pr.updated_at)}`, type: 'converted_to_draft', summary: 'converted to draft' }),
        review_requested: () =>
          p.requested_reviewer || p.requested_team
            ? { key: `review_requested:${p.requested_reviewer?.id ?? `team-${p.requested_team?.id}`}:${ms(pr.updated_at)}`, type: 'review_requested', summary: `requested a review from ${p.requested_reviewer?.login ?? p.requested_team?.slug} on`, details: { reviewer: p.requested_reviewer?.login ?? null, team: p.requested_team?.slug ?? null } }
            : null,
        edited: () => ({ key: `updated:${ms(pr.updated_at)}`, type: 'updated', summary: 'updated' }),
      }[action]?.();
      if (extra) {
        envelopes.push(webhookActivity(source, { key: `pull_request:${record.externalId}:${extra.key}`, type: extra.type, recordRef: ref, actor: p.sender, at: pr.updated_at, summary: `${p.sender?.login ?? 'someone'} ${extra.summary} ${record.externalKey}`, details: extra.details }));
      }
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    case 'pull_request_review': {
      const repo = need(p.repository, 'repository');
      const pr = need(p.pull_request, 'pull_request');
      const review = need(p.review, 'review');
      // The PR record is refreshed too, so a review never points at a PR we don't have.
      const envelopes = [...pullEnvelopes(source, repo, pr), ...reviewEnvelopes(source, repo, pr.number, review)];
      if (action === 'dismissed') {
        envelopes.push(webhookActivity(source, { key: `review:${review.id}:dismissed`, type: 'review_dismissed', recordRef: { recordType: 'review', externalId: String(review.id) }, actor: p.sender, at: pr.updated_at, summary: `${p.sender?.login ?? 'someone'} dismissed a review on ${repo.full_name}#${pr.number}` }));
      }
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    case 'pull_request_review_comment': {
      const repo = need(p.repository, 'repository');
      const pr = need(p.pull_request, 'pull_request');
      const envelopes = [...pullEnvelopes(source, repo, pr), ...reviewCommentEnvelopes(source, repo, need(p.comment, 'comment'), pr.number)];
      if (action === 'deleted') envelopes.find((e) => e.type === 'record' && e.recordType === 'review_comment').deleted = true;
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    case 'push': {
      const repo = need(p.repository, 'repository');
      const ref = String(p.ref ?? '');
      // Branch pushes only; tag pushes and branch deletions carry no new work.
      if (!ref.startsWith('refs/heads/') || p.deleted) return { envelopes: [], resourceRef: resourceRefOf(repo) };
      const branch = ref.slice('refs/heads/'.length);
      const pusher = p.sender ?? null;
      const envelopes = (p.commits ?? [])
        .filter((c) => c?.id && c.distinct !== false)
        .flatMap((c) =>
          commitEnvelopes(source, repo, {
            sha: c.id,
            message: c.message,
            // Push payloads give a login, not an id: only the pusher's own commits are attributed.
            authorUser: c.author?.username && pusher?.login === c.author.username ? pusher : null,
            authorName: c.author?.name ?? null,
            committerName: c.committer?.name ?? null,
            authoredAt: c.timestamp ?? null,
            committedAt: c.timestamp ?? null,
            branch,
            url: c.url ?? null,
            pusher,
          }),
        );
      return { envelopes, resourceRef: resourceRefOf(repo) };
    }

    default:
      return { envelopes: [] };
  }
}
