import { api } from './client.js';

export const listTeams = () => api('/teams');
export const getTeam = (id) => api(`/teams/${id}`);
export const createTeam = (body) => api('/teams', { method: 'POST', body });
export const updateTeam = (id, body) => api(`/teams/${id}`, { method: 'PATCH', body });
export const addTeamMembers = (id, userIds) => api(`/teams/${id}/members`, { method: 'POST', body: { userIds } });
export const removeTeamMember = (id, userId) => api(`/teams/${id}/members/${userId}`, { method: 'DELETE' });
