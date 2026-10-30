import { api } from './client.js';

export function listProjects({ status, includeArchived = false, q } = {}) {
  const params = new URLSearchParams({ includeArchived: String(includeArchived) });
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  return api(`/projects?${params}`);
}

export const getProject = (id) => api(`/projects/${id}`);
export const createProject = (body) => api('/projects', { method: 'POST', body });
export const updateProject = (id, body) => api(`/projects/${id}`, { method: 'PATCH', body });

export const addProjectMembers = (id, body) => api(`/projects/${id}/members`, { method: 'POST', body });
export const removeProjectMember = (id, userId) => api(`/projects/${id}/members/${userId}`, { method: 'DELETE' });

export const getProjectMeetings = (id) => api(`/projects/${id}/meetings`);
export const getProjectTasks = (id) => api(`/projects/${id}/tasks`);
export const getProjectActivity = (id) => api(`/projects/${id}/activity`);
