// Built-in correlation matchers (Phase 5). Each looks at one subject (an external record, a task or
// a meeting) and proposes related records with a confidence and human-readable evidence. They are
// provider-independent: they only use the unified model (external_records, action_items, meetings,
// identities, projects). Nothing here confirms anything; services/correlation/index.js stores the
// proposals as suggestions for people to review.
//
//   key-reference      explicit keys in text: "acme/api#12", "PAY-42", or "#12" inside a repository
//   wording-overlap    a task and an issue/PR of the same project describe the same work
//   meeting-window     an issue/PR created around a meeting of its project, about the same topic
const STOP = new Set(
  'the and for with from this that into when then than have will would should could about after before over under also just only more most some such their there these those what which while your ours them they were been being does done make made need needs fix fixes fixed add adds added update updates updated issue issues task tasks meeting work please pull request merge merged commit review'.split(
    ' ',
  ),
);

/**
 * Significant words: lower-case, 4+ letters, no stop words, no numbers. URLs and keys
 * ("acme/api#12", "PAY-42", shas) are removed first: they are identifiers (the key-reference
 * matcher's job), not words about the topic.
 */
export function tokens(text) {
  return new Set(
    String(text ?? '')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\w.-]+\/[\w.-]+(?:#\d+|@[0-9a-f]+)?/g, ' ')
      .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, ' ')
      .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)),
  );
}

const shared = (a, b) => [...a].filter((w) => b.has(w));
const round = (n) => Math.round(n * 100) / 100;
const WORK_TYPES = ['issue', 'pull_request'];

async function personOf(conn, identityId) {
  if (!identityId) return null;
  const [[row]] = await conn.query('SELECT user_id FROM external_identities WHERE id = ?', [identityId]);
  return row?.user_id ?? null;
}

// ---- key-reference ----------------------------------------------------------------------------
const FULL_KEY = /\b([\w.-]+\/[\w.-]+#\d+)\b/g; // GitHub style owner/repo#12
const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g; // Jira style PAY-42
const SHORT_REF = /(?:^|[\s(])#(\d+)\b/g; // "#12" inside one repository

export const keyReference = {
  id: 'key-reference',
  appliesTo: ['external_record', 'action_item', 'meeting'],
  async run(conn, subject) {
    const text = `${subject.title ?? ''}\n${subject.body ?? ''}`;
    const keys = new Map(); // key -> confidence
    for (const m of text.matchAll(FULL_KEY)) keys.set(m[1], 0.9);
    for (const m of text.matchAll(TICKET_KEY)) keys.set(m[1], 0.9);
    // A bare "#12" only means something inside the same repository.
    const repo = subject.type === 'external_record' && subject.key?.includes('#') ? subject.key.split('#')[0] : subject.key?.split('@')[0];
    if (repo && subject.type === 'external_record') {
      for (const m of text.matchAll(SHORT_REF)) if (!keys.has(`${repo}#${m[1]}`)) keys.set(`${repo}#${m[1]}`, 0.75);
    }
    if (!keys.size) return [];
    const [rows] = await conn.query(
      'SELECT id, external_key FROM external_records WHERE external_key IN (?) AND source_deleted_at IS NULL',
      [[...keys.keys()]],
    );
    return rows
      .filter((r) => !(subject.type === 'external_record' && r.id === subject.id))
      .map((r) => ({
        to: { type: 'external_record', id: r.id },
        linkType: 'references',
        confidence: keys.get(r.external_key),
        evidence: { reason: `Mentions ${r.external_key}`, keys: [r.external_key] },
      }));
  },
};

// ---- wording-overlap --------------------------------------------------------------------------
/** Confidence from how much of the smaller description the other one covers (+ same person). */
function overlapScore(a, b, samePerson) {
  const common = shared(a, b);
  const base = Math.min(a.size, b.size) || 1;
  const coverage = common.length / base;
  if (common.length < 2 || coverage < 0.5) return null;
  return { confidence: round(Math.min(0.9, 0.45 + 0.35 * coverage + (samePerson ? 0.1 : 0))), common };
}

export const wordingOverlap = {
  id: 'wording-overlap',
  appliesTo: ['action_item', 'external_record'],
  async run(conn, subject) {
    if (!subject.projectId) return [];
    const mine = tokens(`${subject.title ?? ''} ${subject.body ?? ''}`);
    if (mine.size < 2) return [];
    const query = [...mine].join(' ');
    if (subject.type === 'action_item') {
      if (subject.reviewStatus !== 'approved') return [];
      const [rows] = await conn.query(
        `SELECT id, title, body, author_identity_id FROM external_records
         WHERE project_id = ? AND record_type IN (?) AND source_deleted_at IS NULL
           AND MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE)
         LIMIT 20`,
        [subject.projectId, WORK_TYPES, query],
      );
      const out = [];
      for (const r of rows) {
        const samePerson = Boolean(subject.assigneeUserId) && (await personOf(conn, r.author_identity_id)) === subject.assigneeUserId;
        const score = overlapScore(mine, tokens(`${r.title} ${r.body ?? ''}`), samePerson);
        if (score) {
          out.push({
            from: { type: 'action_item', id: subject.id },
            to: { type: 'external_record', id: r.id },
            linkType: 'tracks',
            confidence: score.confidence,
            evidence: { reason: `Same project; both mention ${score.common.slice(0, 5).join(', ')}${samePerson ? '; same person' : ''}`, sharedTerms: score.common.slice(0, 10), samePerson },
          });
        }
      }
      return out;
    }
    if (!WORK_TYPES.includes(subject.recordType) || subject.deleted) return [];
    const [rows] = await conn.query(
      `SELECT ai.id, ai.title, ai.description, ai.assignee_user_id FROM action_items ai
       WHERE ai.project_id = ? AND ai.review_status = 'approved'
         AND MATCH(ai.title, ai.description) AGAINST (? IN NATURAL LANGUAGE MODE)
       LIMIT 20`,
      [subject.projectId, query],
    );
    const author = await personOf(conn, subject.authorIdentityId);
    return rows
      .map((t) => {
        const samePerson = Boolean(author) && author === t.assignee_user_id;
        const score = overlapScore(mine, tokens(`${t.title} ${t.description ?? ''}`), samePerson);
        return (
          score && {
            from: { type: 'action_item', id: t.id },
            to: { type: 'external_record', id: subject.id },
            linkType: 'tracks',
            confidence: score.confidence,
            evidence: { reason: `Same project; both mention ${score.common.slice(0, 5).join(', ')}${samePerson ? '; same person' : ''}`, sharedTerms: score.common.slice(0, 10), samePerson },
          }
        );
      })
      .filter(Boolean);
  },
};

// ---- meeting-window ---------------------------------------------------------------------------
const WINDOW_BEFORE_MS = 1 * 86_400_000;
const WINDOW_AFTER_MS = 3 * 86_400_000;

async function meetingTerms(conn, meetingId, title) {
  const [items] = await conn.query("SELECT title FROM action_items WHERE meeting_id = ? AND review_status <> 'rejected'", [meetingId]);
  return tokens(`${title} ${items.map((i) => i.title).join(' ')}`);
}

function windowScore(meetingAt, createdAt, meetingWords, recordWords) {
  if (!meetingAt || !createdAt) return null;
  const delta = new Date(createdAt).getTime() - new Date(meetingAt).getTime();
  if (delta < -WINDOW_BEFORE_MS || delta > WINDOW_AFTER_MS) return null;
  const common = shared(meetingWords, recordWords);
  if (!common.length) return null;
  return { confidence: round(Math.min(0.8, 0.45 + 0.1 * common.length)), common, days: round(delta / 86_400_000) };
}

export const meetingWindow = {
  id: 'meeting-window',
  appliesTo: ['meeting', 'external_record'],
  async run(conn, subject) {
    if (!subject.projectId) return [];
    if (subject.type === 'meeting') {
      const at = subject.scheduledAt ?? subject.updatedAt;
      if (!at) return [];
      const words = await meetingTerms(conn, subject.id, subject.title);
      const [rows] = await conn.query(
        `SELECT id, title, body, source_created_at FROM external_records
         WHERE project_id = ? AND record_type IN (?) AND source_deleted_at IS NULL
           AND source_created_at BETWEEN ? AND ?`,
        [subject.projectId, WORK_TYPES, new Date(new Date(at).getTime() - WINDOW_BEFORE_MS), new Date(new Date(at).getTime() + WINDOW_AFTER_MS)],
      );
      return rows
        .map((r) => {
          const s = windowScore(at, r.source_created_at, words, tokens(`${r.title} ${r.body ?? ''}`));
          return s && { from: { type: 'external_record', id: r.id }, to: { type: 'meeting', id: subject.id }, linkType: 'discussed_in', confidence: s.confidence, evidence: { reason: `Created ${s.days >= 0 ? `${s.days} day(s) after` : `${-s.days} day(s) before`} the meeting; both mention ${s.common.slice(0, 5).join(', ')}`, sharedTerms: s.common.slice(0, 10) } };
        })
        .filter(Boolean);
    }
    if (!WORK_TYPES.includes(subject.recordType) || subject.deleted || !subject.createdAt) return [];
    const created = new Date(subject.createdAt).getTime();
    const [meetings] = await conn.query(
      `SELECT id, title, scheduled_at FROM meetings WHERE project_id = ? AND scheduled_at BETWEEN ? AND ?`,
      [subject.projectId, new Date(created - WINDOW_AFTER_MS), new Date(created + WINDOW_BEFORE_MS)],
    );
    const mine = tokens(`${subject.title} ${subject.body ?? ''}`);
    const out = [];
    for (const m of meetings) {
      const s = windowScore(m.scheduled_at, subject.createdAt, await meetingTerms(conn, m.id, m.title), mine);
      if (s) out.push({ from: { type: 'external_record', id: subject.id }, to: { type: 'meeting', id: m.id }, linkType: 'discussed_in', confidence: s.confidence, evidence: { reason: `Created ${s.days} day(s) after “${m.title}”; both mention ${s.common.slice(0, 5).join(', ')}`, sharedTerms: s.common.slice(0, 10) } });
    }
    return out;
  },
};

export const BUILT_IN_MATCHERS = [keyReference, wordingOverlap, meetingWindow];
