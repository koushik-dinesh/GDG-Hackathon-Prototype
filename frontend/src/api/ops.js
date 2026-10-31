import { api } from './client.js';

const qs = (params) => new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const getOpsSummary = () => api('/ops/summary');
export const listJobs = (params) => api(`/ops/jobs?${qs(params)}`);
export const retryJob = (id) => api(`/ops/jobs/${id}/retry`, { method: 'POST' });
export const cancelJob = (id) => api(`/ops/jobs/${id}/cancel`, { method: 'POST' });
export const listAudit = (params) => api(`/ops/audit?${qs(params)}`);
export const listAuditActions = () => api('/ops/audit/actions');
export const listOpsEmails = (params) => api(`/ops/emails?${qs(params)}`);
export const listAiRuns = (params) => api(`/ops/ai-runs?${qs(params)}`);
