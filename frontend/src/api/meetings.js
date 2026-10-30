import { api } from './client.js';

export function listMeetings({ status, q, projectId, limit = 25, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) params.set('status', status);
  if (projectId) params.set('projectId', String(projectId));
  if (q) params.set('q', q);
  return api(`/meetings?${params}`);
}

export const getMeeting = (id) => api(`/meetings/${id}`);
export const createMeeting = (body) => api('/meetings', { method: 'POST', body });
export const updateMeeting = (id, body) => api(`/meetings/${id}`, { method: 'PATCH', body });

export const getTranscript = (meetingId) => api(`/meetings/${meetingId}/transcript`);
export const uploadTranscript = (meetingId, body) =>
  api(`/meetings/${meetingId}/transcript/upload`, { method: 'POST', body });

// AI extraction and review (Phases 3–4)
export const startExtraction = (meetingId) => api(`/meetings/${meetingId}/extract`, { method: 'POST' });
export const getActionItems = (meetingId) => api(`/meetings/${meetingId}/action-items`);
export const createActionItem = (meetingId, body) => api(`/meetings/${meetingId}/action-items`, { method: 'POST', body });
export const finishReview = (meetingId) => api(`/meetings/${meetingId}/approve`, { method: 'POST' });
