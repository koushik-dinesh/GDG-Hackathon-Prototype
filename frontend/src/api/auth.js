import { api } from './client.js';

export const login = (email, password) =>
  api('/auth/login', { method: 'POST', body: { email, password }, skipAuthRedirect: true });

export const logout = () => api('/auth/logout', { method: 'POST', skipAuthRedirect: true });

export const me = () => api('/auth/me', { skipAuthRedirect: true });

// Public invitation endpoints (no session yet).
export const verifyInvitation = (token) =>
  api('/auth/invitations/verify', { method: 'POST', body: { token }, skipAuthRedirect: true });
export const acceptInvitation = (token, password) =>
  api('/auth/invitations/accept', { method: 'POST', body: { token, password }, skipAuthRedirect: true });
