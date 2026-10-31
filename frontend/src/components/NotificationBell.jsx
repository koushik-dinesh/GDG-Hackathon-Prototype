import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { getUnreadCount } from '../api/me.js';

const POLL_MS = 60_000;
const CHANGED = 'workagent:notifications-changed';

/** Tells the badge to re-read the count (the Notifications page calls this after marking read). */
export const announceNotificationsChanged = () => window.dispatchEvent(new Event(CHANGED));

/**
 * Header link to the notifications with the unread count. Reads the count once a minute while the
 * tab is visible, when the tab comes back, and when this tab changed something; a failed read just
 * keeps the last number (a 401 signs out through the API client).
 */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (document.visibilityState === 'hidden') return;
    getUnreadCount()
      .then((d) => setUnread(d.unread))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener(CHANGED, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHANGED, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refresh]);

  return (
    <NavLink
      to="/notifications"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      className={({ isActive }) =>
        `relative rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50 ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-700'}`
      }
    >
      <span className="hidden sm:inline">Notifications</span>
      <span className="sm:hidden" aria-hidden="true">
        Inbox
      </span>
      {unread > 0 && (
        <span aria-hidden="true" className="absolute -right-2 -top-2 min-w-5 rounded-full bg-red-600 px-1.5 text-center text-xs font-medium leading-5 text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </NavLink>
  );
}
