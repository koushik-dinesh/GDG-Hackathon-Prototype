import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../api/me.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { announceNotificationsChanged } from '../components/NotificationBell.jsx';
import { Button, ErrorAlert, Loading } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

// Links come from the server and are always in-app paths; anything else isn't followed.
const safeLink = (link) => (typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : null);

/** The signed-in person's notifications (Phase 10): newest first, "Load more" appends older ones. */
export function NotificationsPage() {
  const navigate = useNavigate();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before) => {
      setError(null);
      try {
        const d = await listNotifications({ unread: onlyUnread, before });
        setItems((prev) => (before ? [...(prev ?? []), ...d.notifications] : d.notifications));
        setNext(d.next);
      } catch (err) {
        setError(err);
      }
    },
    [onlyUnread],
  );
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const applyRead = (matches) =>
    setItems((list) => (onlyUnread ? list.filter((n) => !matches(n)) : list.map((n) => (matches(n) ? { ...n, read: true } : n))));

  async function markRead(n) {
    setError(null);
    try {
      await markNotificationRead(n.id);
      applyRead((x) => x.id === n.id);
      announceNotificationsChanged();
    } catch (err) {
      setError(err);
    }
  }

  async function markAll() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await markAllNotificationsRead();
      applyRead(() => true);
      announceNotificationsChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function open(e, n, link) {
    e.preventDefault();
    if (!n.read) await markRead(n);
    navigate(link);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Notifications</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
            Unread only
          </label>
          <Button variant="secondary" onClick={markAll} disabled={busy || !items?.some((n) => !n.read)}>
            Mark all as read
          </Button>
          <Link to="/profile" className="text-sm text-slate-700 underline-offset-2 hover:underline">
            Preferences
          </Link>
        </div>
      </div>
      <ErrorAlert error={error} />
      {items === null && !error && <Loading />}
      {items?.length === 0 && (
        <EmptyState title={onlyUnread ? 'Nothing unread' : 'No notifications yet'}>
          {onlyUnread ? 'You have read all your notifications.' : 'Tasks assigned to you, overdue work and other updates will appear here.'}
        </EmptyState>
      )}
      {items?.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {items.map((n) => {
            const link = safeLink(n.link);
            return (
              <li key={n.id} className={`flex flex-wrap items-start justify-between gap-3 px-5 py-3 ${n.read ? '' : 'bg-sky-50'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {!n.read && (
                      <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">Unread</span>
                    )}
                    {link ? (
                      <a href={link} onClick={(e) => open(e, n, link)} className={`break-words text-sm text-slate-900 hover:underline ${n.read ? '' : 'font-medium'}`}>
                        {n.title}
                      </a>
                    ) : (
                      <span className={`break-words text-sm text-slate-900 ${n.read ? '' : 'font-medium'}`}>{n.title}</span>
                    )}
                  </div>
                  {n.body && <p className="mt-1 break-words text-sm text-slate-600">{n.body}</p>}
                  <p className="mt-1 text-xs text-slate-500">{formatDateTime(n.createdAt)}</p>
                </div>
                {!n.read && (
                  <Button variant="link" onClick={() => markRead(n)} aria-label={`Mark “${n.title}” as read`}>
                    Mark as read
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <div className="text-center">
          <Button variant="secondary" onClick={() => load(next)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
