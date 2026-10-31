import { api } from './client.js';

// Synced work, the unified activity feed, relationships and search (Phase 3A/4).
// Visibility follows projects and tasks (server-side).
const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)).toString();

export const listExternalRecords = (params) => api(`/external-records?${qs(params)}`);
export const getExternalRecord = (id) => api(`/external-records/${id}`);
export const listActivities = (params) => api(`/activities?${qs(params)}`);
export const listActivityTypes = () => api('/activities/types');

export const listRecordLinks = (type, id) => api(`/record-links?${qs({ type, id })}`);
export const listLinkSuggestions = () => api('/record-links?status=suggested');
export const createRecordLink = (from, to, linkType) => api('/record-links', { method: 'POST', body: { from, to, linkType } });
export const reviewRecordLink = (id, status) => api(`/record-links/${id}`, { method: 'PATCH', body: { status } });

export const searchRecords = (params) => api(`/search?${qs(params)}`);
