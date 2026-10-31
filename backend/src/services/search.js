// Unified search (Phase 4) across projects, meetings, tasks and external records, with MySQL
// InnoDB FULLTEXT indexes (migration 008) and no extra infrastructure.
//
// - Words of 3+ characters use FULLTEXT in boolean mode as prefixes (+word*), so every word must
//   match; shorter queries and keys ("#12", "PAY-4", a commit sha) use LIKE on titles and keys.
// - Each kind is filtered by the same visibility rules as the rest of the app
//   (services/records/access.js); invisible things are never returned.
// - Results share the unified summary shape (services/records/refs.js) plus a relevance score.
import { pool } from '../db/pool.js';
import { INTERNAL_PROVIDER } from './activities/types.js';
import { taskVisibilitySql } from './records/access.js';
import { EXTERNAL_SUMMARY_SELECT, externalSummary, hrefFor } from './records/refs.js';

export const SEARCH_TYPES = ['project', 'meeting', 'task', 'external_record'];
const MIN_FULLTEXT = 3;

/** Turns user input into a safe boolean-mode query, or null when LIKE must be used. */
export function fulltextQuery(q) {
  const words = q
    .replace(/[+\-<>()~*"@]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length || words.some((w) => w.length < MIN_FULLTEXT)) return null;
  return words.map((w) => `+${w}*`).join(' ');
}

const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const snippet = (text) => (text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 180) : null);

function textCondition(columns, keyColumn, q) {
  const ft = fulltextQuery(q);
  const parts = [];
  const params = [];
  let score = '0';
  const scoreParams = [];
  if (ft) {
    parts.push(`MATCH(${columns}) AGAINST (? IN BOOLEAN MODE)`);
    params.push(ft);
    score = `MATCH(${columns}) AGAINST (? IN BOOLEAN MODE)`;
    scoreParams.push(ft);
  }
  // Titles (and keys) always match by substring too, so short words and identifiers work.
  const titleColumn = columns.split(',')[0].trim();
  parts.push(`${titleColumn} LIKE ?`);
  params.push(like(q));
  if (keyColumn) {
    parts.push(`${keyColumn} LIKE ?`);
    params.push(like(q));
  }
  return { sql: `(${parts.join(' OR ')})`, params, score, scoreParams };
}

const inList = (ids) => (ids.length ? { sql: 'IN (?)', params: [ids] } : { sql: 'IN (NULL)', params: [] });

async function searchProjects(scope, q, { projectId, limit }) {
  const t = textCondition('p.name, p.description', null, q);
  const where = [t.sql];
  const params = [...t.params];
  if (!scope.admin) {
    const l = inList(scope.visible);
    where.push(`p.id ${l.sql}`);
    params.push(...l.params);
  }
  if (projectId) {
    where.push('p.id = ?');
    params.push(projectId);
  }
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.description, p.status, p.updated_at, ${t.score} AS score FROM projects p WHERE ${where.join(' AND ')} ORDER BY score DESC, p.updated_at DESC LIMIT ?`,
    [...t.scoreParams, ...params, limit],
  );
  return rows.map((p) => ({ type: 'project', id: p.id, provider: INTERNAL_PROVIDER, recordType: 'project', title: p.name, key: null, url: null, href: `/projects/${p.id}`, status: p.status, projectId: p.id, projectName: p.name, snippet: snippet(p.description), updatedAt: p.updated_at, score: Number(p.score) }));
}

async function searchMeetings(scope, q, { projectId, limit }) {
  const t = textCondition('m.title', null, q);
  const where = [t.sql];
  const params = [...t.params];
  if (!scope.admin) {
    const l = inList(scope.visible);
    where.push(`m.project_id ${l.sql}`);
    params.push(...l.params);
  }
  if (projectId) {
    where.push('m.project_id = ?');
    params.push(projectId);
  }
  const [rows] = await pool.query(
    `SELECT m.id, m.title, m.status, m.project_id, p.name AS project_name, m.scheduled_at, m.updated_at, ${t.score} AS score
     FROM meetings m LEFT JOIN projects p ON p.id = m.project_id WHERE ${where.join(' AND ')} ORDER BY score DESC, m.updated_at DESC LIMIT ?`,
    [...t.scoreParams, ...params, limit],
  );
  return rows.map((m) => {
    const s = { type: 'meeting', id: m.id, provider: INTERNAL_PROVIDER, recordType: 'meeting', title: m.title, key: null, url: null, href: `/admin/meetings/${m.id}`, status: m.status, projectId: m.project_id, projectName: m.project_name, snippet: null, updatedAt: m.updated_at, score: Number(m.score) };
    return { ...s, href: hrefFor(s, scope) };
  });
}

async function searchTasks(scope, q, { projectId, limit }) {
  const t = textCondition('ai.title, ai.description', null, q);
  const where = [t.sql];
  const params = [...t.params];
  const v = taskVisibilitySql(scope, 'ai', 'm');
  if (v.sql) {
    where.push(v.sql);
    params.push(...v.params);
  }
  if (projectId) {
    where.push('ai.project_id = ?');
    params.push(projectId);
  }
  const [rows] = await pool.query(
    `SELECT ai.id, ai.title, ai.description, ai.task_status, ai.review_status, ai.project_id, ai.assignee_user_id, ai.meeting_id, ai.updated_at,
            p.name AS project_name, u.full_name AS assignee_name, ${t.score} AS score
     FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN projects p ON p.id = ai.project_id LEFT JOIN users u ON u.id = ai.assignee_user_id
     WHERE ${where.join(' AND ')} ORDER BY score DESC, ai.updated_at DESC LIMIT ?`,
    [...t.scoreParams, ...params, limit],
  );
  return rows.map((r) => {
    const s = { type: 'action_item', id: r.id, provider: INTERNAL_PROVIDER, recordType: 'task', title: r.title, key: null, url: null, status: r.review_status === 'approved' ? r.task_status : r.review_status, projectId: r.project_id, projectName: r.project_name, assigneeUserId: r.assignee_user_id, assigneeName: r.assignee_name, meetingId: r.meeting_id, snippet: snippet(r.description), updatedAt: r.updated_at, score: Number(r.score) };
    return { ...s, href: hrefFor(s, scope) };
  });
}

async function searchExternal(scope, q, { projectId, limit, recordType, provider, includeDeleted }) {
  const t = textCondition('r.title, r.body', 'r.external_key', q);
  const where = [t.sql];
  const params = [...t.params];
  if (!scope.admin) {
    const l = inList(scope.visible);
    where.push(`r.project_id ${l.sql}`);
    params.push(...l.params);
  }
  if (projectId) {
    where.push('r.project_id = ?');
    params.push(projectId);
  }
  if (recordType) {
    where.push('r.record_type = ?');
    params.push(recordType);
  }
  if (provider) {
    where.push('r.provider = ?');
    params.push(provider);
  }
  if (!includeDeleted) where.push('r.source_deleted_at IS NULL');
  const [rows] = await pool.query(
    `${EXTERNAL_SUMMARY_SELECT.replace('SELECT r.id,', `SELECT ${t.score} AS score, LEFT(r.body, 400) AS body_start, p.name AS project_name, r.id,`)}
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE ${where.join(' AND ')} ORDER BY score DESC, r.source_updated_at DESC LIMIT ?`,
    [...t.scoreParams, ...params, limit],
  );
  return rows.map((r) => ({ ...externalSummary(r), projectName: r.project_name, snippet: snippet(r.body_start), score: Number(r.score) }));
}

/**
 * options: { types[], projectId, recordType, provider, includeDeleted, limit (per type) }
 * Returns { results: [...], counts: { project, meeting, task, external_record } }.
 */
export async function search(scope, q, { types = SEARCH_TYPES, limit = 10, ...opts } = {}) {
  const run = {
    project: () => searchProjects(scope, q, { ...opts, limit }),
    meeting: () => searchMeetings(scope, q, { ...opts, limit }),
    task: () => searchTasks(scope, q, { ...opts, limit }),
    external_record: () => searchExternal(scope, q, { ...opts, limit }),
  };
  const wanted = opts.recordType || opts.provider ? types.filter((t) => t === 'external_record') : types;
  const groups = await Promise.all(wanted.map((t) => run[t]().then((rows) => [t, rows])));
  const results = groups.flatMap(([, rows]) => rows).sort((a, b) => b.score - a.score || new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
  return { results, counts: Object.fromEntries(groups.map(([t, rows]) => [t, rows.length])) };
}
