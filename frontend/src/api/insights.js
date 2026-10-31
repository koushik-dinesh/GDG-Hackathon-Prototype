import { api } from './client.js';

const qs = (params) => new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const getInsights = (params) => api(`/insights?${qs(params)}`);
