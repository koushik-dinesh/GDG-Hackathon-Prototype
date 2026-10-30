// GitHub objects -> normalized envelopes (Phase 3B). Used by both sync and webhooks, so the same
// object always produces the same record and the same activity keys (no duplicates across origins).
//
// Record identity (external_id), stable and derivable from every payload that mentions the object:
//   repository      <repo id>
//   issue / PR      <repo id>#<number>   (issues and PRs share a number space per repository)
//   comment         <comment id>          review: <review id>   review_comment: <comment id>
//   commit          <repo id>:<sha>
// People are keyed by GitHub's numeric user id (logins can change). No emails are passed on:
// commit emails are not verified and must never drive identity matching.

const ms = (iso) => (iso ? Date.parse(iso) : null);

export function identityOf(user) {
  if (!user || user.id === undefined || user.id === null) return null;
  return { type: 'identity', externalUserId: String(user.id), login: user.login ?? null, displayName: user.name ?? null, isBot: user.type === 'Bot' };
}
const userRef = (user) => (user && user.id !== undefined && user.id !== null ? { externalUserId: String(user.id) } : null);
const people = (users) => (users ?? []).filter((u) => u?.id !== undefined).map((u) => ({ id: u.id, login: u.login }));
const labelsOf = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const milestoneOf = (m) => (m ? { title: m.title, number: m.number, state: m.state, dueOn: m.due_on ?? null } : null);

export const repoRef = (repo) => ({ id: String(repo.id), fullName: repo.full_name ?? repo.name });
const numberKey = (repo, number) => `${repo.id}#${number}`;

/** Activity helper. `key` must describe what happened, not how we learned about it. */
const activity = (source, key, activityType, recordRef, actor, occurredAt, summary, details) => ({
  type: 'activity',
  dedupeKey: `${source}:${key}`,
  activityType,
  recordRef,
  actorRef: userRef(actor),
  occurredAt,
  summary,
  details: details ?? null,
});

export function repositoryEnvelopes(source, repo) {
  return [
    identityOf(repo.owner),
    {
      type: 'record',
      recordType: 'repository',
      externalId: String(repo.id),
      externalKey: repo.full_name,
      url: repo.html_url ?? null,
      title: repo.full_name,
      body: repo.description ?? null,
      state: repo.archived ? 'archived' : 'active',
      statusCategory: 'unknown',
      authorRef: null,
      sourceCreatedAt: repo.created_at ?? null,
      sourceUpdatedAt: repo.updated_at ?? null,
      metadata: {
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner?.login ?? null,
        defaultBranch: repo.default_branch ?? null,
        visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
        private: Boolean(repo.private),
        archived: Boolean(repo.archived),
      },
    },
  ].filter(Boolean);
}

/** Repository -> integration resource (the admin's selectable list). */
export const resourceOf = (repo) => ({
  resourceType: 'repository',
  externalId: String(repo.id),
  name: repo.full_name,
  url: repo.html_url ?? null,
  metadata: {
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? null,
    owner: repo.owner?.login ?? null,
    ownerType: repo.owner?.type ?? null,
    defaultBranch: repo.default_branch ?? null,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
  },
});

function issueStatus(issue) {
  if (issue.state === 'open') return 'todo';
  return issue.state_reason === 'not_planned' ? 'cancelled' : 'done';
}

export function issueEnvelopes(source, repo, issue) {
  const key = numberKey(repo, issue.number);
  const ref = { recordType: 'issue', externalId: key };
  const out = [identityOf(issue.user), ...(issue.assignees ?? []).map(identityOf)].filter(Boolean);
  out.push({
    type: 'record',
    ...ref,
    externalKey: `${repo.full_name}#${issue.number}`,
    url: issue.html_url ?? null,
    title: issue.title ?? null,
    body: issue.body ?? null,
    state: issue.state,
    statusCategory: issueStatus(issue),
    authorRef: userRef(issue.user),
    sourceCreatedAt: issue.created_at,
    sourceUpdatedAt: issue.updated_at,
    metadata: {
      number: issue.number,
      githubId: issue.id,
      labels: labelsOf(issue.labels),
      assignees: people(issue.assignees),
      milestone: milestoneOf(issue.milestone),
      closedAt: issue.closed_at ?? null,
      stateReason: issue.state_reason ?? null,
      comments: issue.comments ?? null,
    },
  });
  out.push(activity(source, `issue:${key}:created`, 'created', ref, issue.user, issue.created_at, `${issue.user?.login ?? 'someone'} opened ${repo.full_name}#${issue.number}`));
  if (issue.closed_at) {
    out.push(
      activity(source, `issue:${key}:closed:${ms(issue.closed_at)}`, 'closed', ref, issue.closed_by ?? null, issue.closed_at, `${repo.full_name}#${issue.number} was closed`, {
        stateReason: issue.state_reason ?? null,
      }),
    );
  }
  return out;
}

function pullStatus(pr) {
  if (pr.merged_at) return 'done';
  if (pr.state === 'closed') return 'cancelled';
  return 'in_progress';
}

export function pullEnvelopes(source, repo, pr) {
  const key = numberKey(repo, pr.number);
  const ref = { recordType: 'pull_request', externalId: key };
  const out = [identityOf(pr.user), ...(pr.assignees ?? []).map(identityOf), ...(pr.requested_reviewers ?? []).map(identityOf)].filter(Boolean);
  out.push({
    type: 'record',
    ...ref,
    externalKey: `${repo.full_name}#${pr.number}`,
    url: pr.html_url ?? null,
    title: pr.title ?? null,
    body: pr.body ?? null,
    state: pr.merged_at ? 'merged' : pr.state,
    statusCategory: pullStatus(pr),
    authorRef: userRef(pr.user),
    sourceCreatedAt: pr.created_at,
    sourceUpdatedAt: pr.updated_at,
    metadata: {
      number: pr.number,
      githubId: pr.id,
      draft: Boolean(pr.draft),
      headRef: pr.head?.ref ?? null,
      headSha: pr.head?.sha ?? null,
      baseRef: pr.base?.ref ?? null,
      merged: Boolean(pr.merged_at),
      mergedAt: pr.merged_at ?? null,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      closedAt: pr.closed_at ?? null,
      labels: labelsOf(pr.labels),
      assignees: people(pr.assignees),
      requestedReviewers: people(pr.requested_reviewers),
      requestedTeams: (pr.requested_teams ?? []).map((t) => t.slug).filter(Boolean),
      milestone: milestoneOf(pr.milestone),
    },
  });
  out.push(activity(source, `pull_request:${key}:created`, 'created', ref, pr.user, pr.created_at, `${pr.user?.login ?? 'someone'} opened pull request ${repo.full_name}#${pr.number}`));
  if (pr.merged_at) {
    out.push(activity(source, `pull_request:${key}:merged:${ms(pr.merged_at)}`, 'merged', ref, pr.merged_by ?? null, pr.merged_at, `${repo.full_name}#${pr.number} was merged`, { baseRef: pr.base?.ref ?? null }));
  } else if (pr.closed_at) {
    out.push(activity(source, `pull_request:${key}:closed:${ms(pr.closed_at)}`, 'closed', ref, null, pr.closed_at, `${repo.full_name}#${pr.number} was closed without merging`));
  }
  return out;
}

/** Issue comments (on issues and on pull requests). `issue` needs number and pull_request|html_url. */
export function commentEnvelopes(source, repo, comment, issue) {
  const number = issue?.number ?? Number(String(comment.issue_url ?? '').split('/').pop());
  const onPull = issue ? Boolean(issue.pull_request) : /\/pull\//.test(comment.html_url ?? '');
  const parentRef = { recordType: onPull ? 'pull_request' : 'issue', externalId: numberKey(repo, number) };
  const ref = { recordType: 'comment', externalId: String(comment.id) };
  return [
    identityOf(comment.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: comment.html_url ?? null,
      title: `Comment on ${repo.full_name}#${number}`,
      body: comment.body ?? null,
      state: null,
      statusCategory: 'unknown',
      authorRef: userRef(comment.user),
      parentRef,
      sourceCreatedAt: comment.created_at,
      sourceUpdatedAt: comment.updated_at ?? comment.created_at,
      metadata: { number, onPullRequest: onPull, githubId: comment.id },
    },
    activity(source, `comment:${comment.id}:created`, 'commented', ref, comment.user, comment.created_at, `${comment.user?.login ?? 'someone'} commented on ${repo.full_name}#${number}`),
  ].filter(Boolean);
}

export function reviewEnvelopes(source, repo, prNumber, review) {
  if (!review.submitted_at) return []; // pending (draft) reviews are private to their author
  const ref = { recordType: 'review', externalId: String(review.id) };
  const state = String(review.state ?? '').toLowerCase();
  return [
    identityOf(review.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: review.html_url ?? null,
      title: `Review (${state.replaceAll('_', ' ')}) on ${repo.full_name}#${prNumber}`,
      body: review.body || null,
      state,
      statusCategory: 'unknown',
      authorRef: userRef(review.user),
      parentRef: { recordType: 'pull_request', externalId: numberKey(repo, prNumber) },
      sourceCreatedAt: review.submitted_at,
      sourceUpdatedAt: review.submitted_at,
      metadata: { number: prNumber, githubId: review.id, commitId: review.commit_id ?? null },
    },
    activity(source, `review:${review.id}:submitted`, 'review_submitted', ref, review.user, review.submitted_at, `${review.user?.login ?? 'someone'} reviewed ${repo.full_name}#${prNumber} (${state.replaceAll('_', ' ')})`, {
      state,
    }),
  ].filter(Boolean);
}

export function reviewCommentEnvelopes(source, repo, comment, prNumber) {
  const number = prNumber ?? Number(String(comment.pull_request_url ?? '').split('/').pop());
  const ref = { recordType: 'review_comment', externalId: String(comment.id) };
  return [
    identityOf(comment.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: comment.html_url ?? null,
      title: `Review comment on ${repo.full_name}#${number}${comment.path ? ` (${comment.path})` : ''}`,
      body: comment.body ?? null,
      state: null,
      statusCategory: 'unknown',
      authorRef: userRef(comment.user),
      parentRef: { recordType: 'pull_request', externalId: numberKey(repo, number) },
      sourceCreatedAt: comment.created_at,
      sourceUpdatedAt: comment.updated_at ?? comment.created_at,
      // The diff hunk is not stored: it can be large and is code, not discussion.
      metadata: { number, githubId: comment.id, path: comment.path ?? null, line: comment.line ?? null, reviewId: comment.pull_request_review_id ?? null, inReplyTo: comment.in_reply_to_id ?? null },
    },
    activity(source, `review_comment:${comment.id}:created`, 'commented', ref, comment.user, comment.created_at, `${comment.user?.login ?? 'someone'} commented on the diff of ${repo.full_name}#${number}`),
  ].filter(Boolean);
}

/**
 * A commit, from the REST API (`item`) or a push payload (`pushCommit`, with the pusher as the
 * GitHub user when the commit's username matches).
 */
export function commitEnvelopes(source, repo, { sha, message, authorUser, authorName, committerName, authoredAt, committedAt, branch, url, verified, pusher }) {
  const ref = { recordType: 'commit', externalId: `${repo.id}:${sha}` };
  const firstLine = String(message ?? '').split('\n')[0];
  const actor = authorUser ?? pusher ?? null;
  return [
    identityOf(authorUser),
    identityOf(pusher),
    {
      type: 'record',
      ...ref,
      externalKey: `${repo.full_name}@${sha.slice(0, 7)}`,
      url: url ?? null,
      title: firstLine || sha.slice(0, 7),
      body: message ?? null,
      state: null,
      statusCategory: 'unknown',
      authorRef: userRef(authorUser),
      sourceCreatedAt: authoredAt ?? committedAt ?? null,
      sourceUpdatedAt: committedAt ?? authoredAt ?? null,
      metadata: { sha, branch: branch ?? null, authorName: authorName ?? null, committerName: committerName ?? null, verified: verified ?? null },
    },
    activity(source, `commit:${repo.id}:${sha}:committed`, 'committed', ref, actor, committedAt ?? authoredAt, `${actor?.login ?? authorName ?? 'someone'} committed to ${repo.full_name}${branch ? ` (${branch})` : ''}: ${firstLine.slice(0, 120)}`),
  ].filter(Boolean);
}

/** REST /commits item -> commitEnvelopes input. */
export const restCommit = (item, branch) => ({
  sha: item.sha,
  message: item.commit?.message,
  authorUser: item.author ?? null,
  authorName: item.commit?.author?.name ?? null,
  committerName: item.commit?.committer?.name ?? null,
  authoredAt: item.commit?.author?.date ?? null,
  committedAt: item.commit?.committer?.date ?? null,
  branch,
  url: item.html_url ?? null,
  verified: item.commit?.verification?.verified ?? null,
});
