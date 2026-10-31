import { api } from './client.js';

const qs = (params) => new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// The signed-in person's profile, password, preferences and notifications (Phase 10).
export const getProfile = () => api('/me/profile');
export const updateProfile = (fields) => api('/me/profile', { method: 'PATCH', body: fields });
export const changePassword = (currentPassword, newPassword) => api('/me/password', { method: 'POST', body: { currentPassword, newPassword } });
export const updatePreferences = (preferences) => api('/me/preferences', { method: 'PUT', body: preferences });

export const listNotifications = (params) => api(`/me/notifications?${qs(params)}`);
export const getUnreadCount = () => api('/me/notifications/unread-count');
export const markNotificationRead = (id) => api(`/me/notifications/${id}/read`, { method: 'POST' });
export const markAllNotificationsRead = () => api('/me/notifications/read-all', { method: 'POST' });
