import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/me.js';
import { NotificationBell } from '../components/NotificationBell.jsx';
import { NotificationsPage } from './Notifications.jsx';

vi.mock('../api/me.js');

const unread = { id: 3, kind: 'task_assigned', title: 'New task: Send the deck', body: 'From “Weekly”', link: '/my/tasks/12', read: false, createdAt: '2026-10-31T10:00:00Z' };
const read = { id: 2, kind: 'task_overdue', title: 'Overdue: Old task', body: null, link: '/projects/4', read: true, createdAt: '2026-10-30T10:00:00Z' };
const external = { id: 1, kind: 'task_assigned', title: 'Strange link', body: null, link: 'https://evil.test', read: true, createdAt: '2026-10-29T10:00:00Z' };

function page() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <NotificationBell />
      <Routes>
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/my/tasks/12" element={<p>Task page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.listNotifications.mockResolvedValue({ notifications: [unread, read, external], next: null });
  api.getUnreadCount.mockResolvedValue({ unread: 1 });
  api.markNotificationRead.mockResolvedValue({ marked: 1 });
  api.markAllNotificationsRead.mockResolvedValue({ marked: 1 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationsPage', () => {
  it('shows read and unread notifications, and follows only in-app links', async () => {
    page();
    expect((await screen.findByRole('link', { name: 'New task: Send the deck' })).getAttribute('href')).toBe('/my/tasks/12');
    expect(screen.getAllByText('Unread')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Overdue: Old task' })).toBeTruthy();
    expect(screen.getByText('Strange link')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Strange link' })).toBeNull();
  });

  it('marks one as read and refreshes the badge', async () => {
    page();
    expect(await screen.findByRole('link', { name: 'Notifications, 1 unread' })).toBeTruthy();
    api.getUnreadCount.mockResolvedValue({ unread: 0 });
    await userEvent.click(await screen.findByRole('button', { name: 'Mark “New task: Send the deck” as read' }));
    expect(api.markNotificationRead).toHaveBeenCalledWith(3);
    expect(await screen.findByRole('link', { name: 'Notifications' })).toBeTruthy();
    expect(screen.queryByText('Unread')).toBeNull();
  });

  it('marks all as read', async () => {
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    expect(api.markAllNotificationsRead).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Unread')).toBeNull());
    expect(screen.getByRole('button', { name: 'Mark all as read' }).disabled).toBe(true);
  });

  it('opening one marks it read and goes to its page', async () => {
    page();
    await userEvent.click(await screen.findByRole('link', { name: 'New task: Send the deck' }));
    expect(api.markNotificationRead).toHaveBeenCalledWith(3);
    expect(await screen.findByText('Task page')).toBeTruthy();
  });

  it('opening one already read sends no request', async () => {
    page();
    await screen.findByRole('link', { name: 'Overdue: Old task' });
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it('loads older ones and filters to unread', async () => {
    api.listNotifications.mockResolvedValueOnce({ notifications: [unread], next: 3 }).mockResolvedValueOnce({ notifications: [read], next: null });
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(api.listNotifications).toHaveBeenLastCalledWith({ unread: false, before: 3 });
    expect(await screen.findByRole('link', { name: 'Overdue: Old task' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    api.listNotifications.mockResolvedValue({ notifications: [], next: null });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }));
    expect(api.listNotifications).toHaveBeenLastCalledWith({ unread: true, before: undefined });
    expect(await screen.findByText('Nothing unread')).toBeTruthy();
  });

  it('shows empty and error states', async () => {
    api.listNotifications.mockResolvedValue({ notifications: [], next: null });
    page();
    expect(await screen.findByText('No notifications yet')).toBeTruthy();
    cleanup();
    api.listNotifications.mockRejectedValue(new Error('Server down'));
    page();
    expect((await screen.findByRole('alert')).textContent).toContain('Server down');
  });
});

describe('NotificationBell', () => {
  it('caps the number and keeps the last count when a read fails', async () => {
    api.getUnreadCount.mockResolvedValue({ unread: 120 });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>,
    );
    expect(await screen.findByText('99+')).toBeTruthy();
    api.getUnreadCount.mockRejectedValue(new Error('offline'));
    window.dispatchEvent(new Event('workagent:notifications-changed'));
    await waitFor(() => expect(api.getUnreadCount).toHaveBeenCalledTimes(2));
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('polls no more than once a minute and not while the tab is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      render(
        <MemoryRouter>
          <NotificationBell />
        </MemoryRouter>,
      );
      expect(api.getUnreadCount).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(59_000);
      expect(api.getUnreadCount).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      expect(api.getUnreadCount).toHaveBeenCalledTimes(2);
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      vi.advanceTimersByTime(60_000);
      expect(api.getUnreadCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByRole('link')).toBeTruthy());
  });
});
