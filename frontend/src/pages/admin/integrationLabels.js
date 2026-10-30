// Labels and colours for integration states (shared by the list and detail pages).
export const CONNECTION_STATUS = {
  pending: { label: 'Pending', cls: 'bg-sky-100 text-sky-800' },
  active: { label: 'Connected', cls: 'bg-emerald-100 text-emerald-800' },
  suspended: { label: 'Suspended', cls: 'bg-amber-100 text-amber-800' },
  error: { label: 'Needs reconnect', cls: 'bg-red-100 text-red-700' },
  disconnected: { label: 'Disconnected', cls: 'bg-slate-100 text-slate-500' },
};

export const HEALTH = {
  unknown: { label: 'Not synced yet', cls: 'text-slate-500' },
  healthy: { label: 'Healthy', cls: 'text-emerald-700' },
  degraded: { label: 'Degraded', cls: 'text-amber-700' },
  failing: { label: 'Failing', cls: 'text-red-700' },
};

export const DELIVERY_STATUS = {
  received: 'Queued',
  processing: 'Processing',
  processed: 'Processed',
  ignored: 'Ignored',
  failed: 'Failed',
};
