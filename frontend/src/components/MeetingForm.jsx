import { useState } from 'react';
import { errorSummary, fieldErrorsFrom, fromLocalInput, toLocalInput } from '../utils/format.js';
import { ParticipantPicker } from './ParticipantPicker.jsx';
import { ProjectSelect } from './ProjectSelect.jsx';
import { Button, ErrorAlert, Field, inputClass } from './ui.jsx';

// Shared by the create page and the meeting detail "Edit" mode.
export function MeetingForm({ initial, submitLabel, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    title: initial?.title ?? '',
    meetingUrl: initial?.meetingUrl ?? '',
    scheduledAt: toLocalInput(initial?.scheduledAt),
    languageHint: initial?.languageHint ?? '',
    participantIds: initial?.participants?.map((p) => p.id) ?? [],
    projectId: initial?.projectId ?? null,
  });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    const clientErrors = {};
    if (!form.title.trim()) clientErrors.title = 'Required';
    if (!/^https?:\/\/\S+$/i.test(form.meetingUrl.trim())) clientErrors.meetingUrl = 'Enter a full http(s) meeting link';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        title: form.title.trim(),
        meetingUrl: form.meetingUrl.trim(),
        scheduledAt: fromLocalInput(form.scheduledAt),
        languageHint: form.languageHint.trim() || null,
        participantIds: form.participantIds,
        projectId: form.projectId,
      });
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <ErrorAlert error={error} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Title" error={errors.title}>
          <input className={inputClass} value={form.title} onChange={set('title')} maxLength={255} required />
        </Field>
        <Field label="Meeting link" error={errors.meetingUrl} hint="Google Meet link, e.g. https://meet.google.com/abc-defg-hij">
          <input className={inputClass} type="url" value={form.meetingUrl} onChange={set('meetingUrl')} maxLength={1024} required />
        </Field>
        <Field label="Scheduled for" error={errors.scheduledAt} hint="Optional. Your local time.">
          <input className={inputClass} type="datetime-local" value={form.scheduledAt} onChange={set('scheduledAt')} />
        </Field>
        <Field label="Language" error={errors.languageHint} hint='Optional, e.g. "en". Leave empty for auto-detect.'>
          <input className={inputClass} value={form.languageHint} onChange={set('languageHint')} maxLength={10} />
        </Field>
        <Field label="Project" error={errors.projectId} hint="Optional. Its action items are listed on the project page.">
          <ProjectSelect
            value={form.projectId}
            current={initial?.project}
            onChange={(projectId) => setForm((f) => ({ ...f, projectId }))}
            disabled={saving}
          />
        </Field>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">Participants</p>
        <ParticipantPicker
          value={form.participantIds}
          onChange={(ids) => setForm((f) => ({ ...f, participantIds: ids }))}
          disabled={saving}
        />
        {errors.participantIds && <p className="mt-1 text-xs text-red-600">{errors.participantIds}</p>}
      </div>

      <div className="flex gap-3">
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
