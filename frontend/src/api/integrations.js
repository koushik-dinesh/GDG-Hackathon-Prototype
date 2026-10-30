import { api } from './client.js';

// Admin integration management (Phase 3A).
export const listProviders = () => api('/integrations/providers');
export const listConnections = () => api('/integrations');
export const getConnection = (id) => api(`/integrations/${id}`);
export const startConnect = (provider) => api(`/integrations/${provider}/connect`, { method: 'POST' });
export const completeConnect = (provider, state, params) => api(`/integrations/${provider}/callback`, { method: 'POST', body: { state, params } });
export const updateConnection = (id, body) => api(`/integrations/${id}`, { method: 'PATCH', body });
export const syncNow = (id) => api(`/integrations/${id}/sync`, { method: 'POST' });
export const disconnect = (id, uninstall = false) => api(`/integrations/${id}/disconnect`, { method: 'POST', body: { uninstall } });
export const refreshResources = (id) => api(`/integrations/${id}/resources/refresh`, { method: 'POST' });
export const updateResource = (id, resourceId, body) => api(`/integrations/${id}/resources/${resourceId}`, { method: 'PATCH', body });
export const listDeliveries = (id) => api(`/integrations/${id}/webhook-deliveries`);
export const replayDelivery = (deliveryId) => api(`/integrations/webhook-deliveries/${deliveryId}/replay`, { method: 'POST' });
