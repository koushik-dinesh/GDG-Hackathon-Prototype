import { api } from './client.js';

// Synced work from connected applications (Phase 3A/3B). Visibility follows projects (server-side).
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const listExternalRecords = (params) => api(`/external-records?${qs(params)}`);
export const getExternalRecord = (id) => api(`/external-records/${id}`);
export const listActivities = (params) => api(`/activities?${qs(params)}`);
