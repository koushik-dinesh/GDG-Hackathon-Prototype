// In-app notifications and preferences (Phase 10). Each notification is for one person, has a
// stable dedupe key (an event never notifies the same person twice) and an in-app link. People
// can turn each kind off; a kind is only ever created for the roles that can act on it.
//
// Kinds:
//   task_assigned        a task you can now see was assigned to you
//   task_overdue         your task passed its due date (owners of the project hear about it too)
//   task_blocked         a task in a project you own was marked blocked (no project: admins; at most daily per task)
//   daily_digest         your open work once a day, from 9:00 in your time zone, when there is something to report
//   suggestions          new relationship suggestions you can decide (admins; managers of both ends; at most daily)
//   integration_error    an integration needs attention (admins, at most daily per connection)
//   jobs_dead            background jobs dead or failed for good, not cancelled (admins, at most daily)
import { pool } from '../../db/pool.js';
import { badRequest } from '../../utils/errors.js';

const EVERYONE = ['admin', 'manager', 'employee'];
const MANAGERS = ['admin', 'manager'];
const ADMINS = ['admin'];
export const KINDS = {
  task_assigned: { label: 'A task is assigned to me', roles: EVERYONE },
  task_overdue: { label: 'A task I own or manage is overdue', roles: EVERYONE },
  task_blocked: { label: 'A task in a project I manage is blocked', roles: MANAGERS },
  daily_digest: { label: 'A daily summary of my open work (9:00 in my time zone)', roles: EVERYONE },
  suggestions: { label: 'New relationship suggestions to review', roles: MANAGERS },
  integration_error: { label: 'An integration needs attention', roles: ADMINS },
  jobs_dead: { label: 'Background jobs failed for good', roles: ADMINS },
};
export const kindsForRole = (role) => Object.keys(KINDS).filter((k) => KINDS[k].roles.includes(role));
const DEFAULTS = { notifications: Object.fromEntries(Object.keys(KINDS).map((k) => [k, true])), timeZone: null };

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});

export async function getPreferences(userId, conn = pool) {
  const [[row]] = await conn.query('SELECT settings FROM user_preferences WHERE user_id = ?', [userId]);
  const saved = row ? parse(row.settings) : {};
  return { notifications: { ...DEFAULTS.notifications, ...(saved.notifications ?? {}) }, timeZone: saved.timeZone ?? null };
}

export function isTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function setPreferences(userId, { notifications, timeZone }) {
  const current = await getPreferences(userId);
  if (timeZone !== undefined && timeZone !== null && !isTimeZone(timeZone)) throw badRequest('Unknown time zone', [{ field: 'timeZone', message: 'Use an IANA time zone such as Europe/Berlin' }]);
  const next = {
    notifications: { ...current.notifications, ...Object.fromEntries(Object.entries(notifications ?? {}).filter(([k]) => KINDS[k])) },
    timeZone: timeZone === undefined ? current.timeZone : timeZone,
  };
  await pool.execute('INSERT INTO user_preferences (user_id, settings) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings = VALUES(settings)', [userId, JSON.stringify(next)]);
  return next;
}

/**
 * Creates a notification unless the person turned the kind off or already has it (dedupe key).
 * Inactive users get nothing. Returns true when one was created.
 */
export async function notify(conn, { userId, kind, title, body = null, link = null, entityType = null, entityId = null, dedupeKey }) {
  if (!KINDS[kind] || !userId) return false;
  if (link && !link.startsWith('/')) throw new Error('notification links are in-app paths');
  const [[user]] = await conn.query('SELECT is_active, role FROM users WHERE id = ?', [userId]);
  if (!user?.is_active || !KINDS[kind].roles.includes(user.role)) return false;
  const prefs = await getPreferences(userId, conn);
  if (prefs.notifications[kind] === false) return false;
  try {
    await conn.execute(
      'INSERT INTO notifications (user_id, kind, title, body, link, entity_type, entity_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, kind, title.slice(0, 300), body ? String(body).slice(0, 1000) : null, link, entityType, entityId, `${kind}:${dedupeKey}:${userId}`.slice(0, 191)],
    );
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

export async function notifyAdmins(conn, args) {
  const [admins] = await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
  let n = 0;
  for (const a of admins) if (await notify(conn, { ...args, userId: a.id })) n += 1;
  return n;
}

const toApi = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, entity: r.entity_type ? { type: r.entity_type, id: r.entity_id } : null, read: Boolean(r.read_at), readAt: r.read_at, createdAt: r.created_at });

export async function list(userId, { unread = false, before, limit = 30 }) {
  const [rows] = await pool.query(
    `SELECT * FROM notifications WHERE user_id = ?${unread ? ' AND read_at IS NULL' : ''}${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    [userId, ...(before ? [before] : []), limit + 1],
  );
  return { notifications: rows.slice(0, limit).map(toApi), next: rows.length > limit ? rows[limit - 1].id : null };
}

export async function unreadCount(userId) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
  return Number(row.n);
}

/** Marks one (or all) of the user's notifications read. Someone else's id is simply not found. */
export async function markRead(userId, id = null) {
  const [result] = await pool.execute(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL${id ? ' AND id = ?' : ''}`,
    id ? [userId, id] : [userId],
  );
  return result.affectedRows;
}
