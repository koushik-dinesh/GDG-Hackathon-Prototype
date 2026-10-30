import { useState } from 'react';
import { Button, ErrorAlert, Field, inputClass } from '../../components/ui.jsx';
import { errorSummary, fieldErrorsFrom } from '../../utils/format.js';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from './projectLabels.js';

/**
 * Shared by "New project" and the detail page's edit mode.
 * owners: list of people who can own a project (admins/managers); shown only when provided.
 * withStatus: show the status select (creation only; the detail page has its own status control).
 */
export function ProjectForm({ initial, submitLabel, onSubmit, onCancel, owners, ownerPlaceholder = 'Me', withStatus = false }) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    status: initial?.status ?? 'planning',
    startDate: initial?.startDate ?? '',
    targetDate: initial?.targetDate ?? '',
    ownerUserId: initial?.ownerUserId ? String(initial.ownerUserId) : '',
  });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    const clientErrors = {};
    if (!form.name.trim()) clientErrors.name = 'Required';
    if (form.startDate && form.targetDate && form.targetDate < form.startDate) clientErrors.targetDate = 'Must be on or after the start date';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        description: form.description.trim() || null,
        startDate: form.startDate || null,
        targetDate: form.targetDate || null,
        ...(withStatus && { status: form.status }),
        ...(owners && form.ownerUserId && { ownerUserId: Number(form.ownerUserId) }),
      });
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <ErrorAlert error={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errors.name}>
          <input className={inputClass} value={form.name} onChange={set('name')} maxLength={200} />
        </Field>
        {owners && (
          <Field label="Owner" error={errors.ownerUserId} hint="Admins and managers can own projects.">
            <select className={inputClass} value={form.ownerUserId} onChange={set('ownerUserId')}>
              {!form.ownerUserId && <option value="">{ownerPlaceholder}</option>}
              {owners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} ({p.role})
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Start date" error={errors.startDate} hint="Optional.">
          <input className={inputClass} type="date" value={form.startDate} onChange={set('startDate')} />
        </Field>
        <Field label="Target completion" error={errors.targetDate} hint="Optional.">
          <input className={inputClass} type="date" value={form.targetDate} onChange={set('targetDate')} />
        </Field>
        {withStatus && (
          <Field label="Status" error={errors.status}>
            <select className={inputClass} value={form.status} onChange={set('status')}>
              {PROJECT_STATUSES.filter((s) => s !== 'archived').map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label="Description" error={errors.description} hint="Optional.">
        <textarea className={inputClass} rows={3} value={form.description} onChange={set('description')} maxLength={5000} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
