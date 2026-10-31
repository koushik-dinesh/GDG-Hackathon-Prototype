import { useEffect, useMemo, useState } from 'react';
import { changePassword, getProfile, updatePreferences, updateProfile } from '../api/me.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../components/ui.jsx';
import { errorSummary } from '../utils/format.js';

const fieldErrors = (err) => Object.fromEntries((err?.details ?? []).filter((d) => d.field).map((d) => [d.field, d.message]));

/** The same rules as the API (utils/validation.js), so most mistakes are caught before sending. */
export function passwordProblems({ currentPassword, newPassword, confirm }) {
  const problems = {};
  if (!currentPassword) problems.currentPassword = 'Required';
  if (newPassword.length < 12) problems.newPassword = 'Use at least 12 characters';
  else if (new TextEncoder().encode(newPassword).length > 72) problems.newPassword = 'Use at most 72 bytes (about 72 characters)';
  else if (!newPassword.trim()) problems.newPassword = 'Password cannot be only spaces';
  else if (newPassword === currentPassword) problems.newPassword = 'Must differ from the current password';
  if (confirm !== newPassword) problems.confirm = 'The two passwords don’t match';
  return problems;
}

function DetailsCard({ profile }) {
  const { updateUser } = useAuth();
  const [fullName, setFullName] = useState(profile.fullName);
  const [saved, setSaved] = useState(profile.fullName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const { user } = await updateProfile({ fullName });
      updateUser(user);
      setFullName(user.fullName);
      setSaved(user.fullName);
      setNotice('Your name was saved.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Your details">
      <form onSubmit={save} className="space-y-4">
        <ErrorAlert error={errorSummary(error)} />
        <SuccessAlert>{notice}</SuccessAlert>
        <Field label="Full name" error={fieldErrors(error).fullName}>
          <input className={inputClass} value={fullName} maxLength={200} required onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Email" hint="Ask an admin to change your email or role.">
          <input className={inputClass} value={profile.email} disabled />
        </Field>
        <Field label="Role">
          <input className={`${inputClass} capitalize`} value={profile.role} disabled />
        </Field>
        <Button type="submit" disabled={busy || !fullName.trim() || fullName.trim() === saved}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}

const NO_PASSWORDS = { currentPassword: '', newPassword: '', confirm: '' };

function PasswordCard() {
  const [form, setForm] = useState(NO_PASSWORDS);
  const [problems, setProblems] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    setError(null);
    setNotice('');
    const found = passwordProblems(form);
    setProblems(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const { otherSessionsSignedOut: n } = await changePassword(form.currentPassword, form.newPassword);
      setForm(NO_PASSWORDS);
      setNotice(`Password changed. ${n === 0 ? 'You weren’t signed in anywhere else.' : `Signed out of ${n} other session${n === 1 ? '' : 's'}.`}`);
    } catch (err) {
      setProblems(fieldErrors(err));
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password">
      <form onSubmit={save} noValidate className="space-y-4">
        <ErrorAlert error={error?.code === 'INVALID_PASSWORD' || error?.code === 'SAME_PASSWORD' ? null : errorSummary(error)} />
        <SuccessAlert>{notice}</SuccessAlert>
        <Field label="Current password" error={problems.currentPassword}>
          <input type="password" autoComplete="current-password" className={inputClass} value={form.currentPassword} onChange={set('currentPassword')} />
        </Field>
        <Field label="New password" error={problems.newPassword} hint="At least 12 characters. Your other sessions are signed out.">
          <input type="password" autoComplete="new-password" className={inputClass} value={form.newPassword} onChange={set('newPassword')} />
        </Field>
        <Field label="Repeat new password" error={problems.confirm}>
          <input type="password" autoComplete="new-password" className={inputClass} value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </form>
    </Card>
  );
}

function PreferencesCard({ kinds, preferences }) {
  const [settings, setSettings] = useState(preferences.notifications);
  const [timeZone, setTimeZone] = useState(preferences.timeZone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const zones = useMemo(() => {
    // Browsers list some zones under older names (Asia/Calcutta) and may leave out UTC.
    return [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Asia/Kolkata', ...(timeZone ? [timeZone] : [])])].sort();
  }, [timeZone]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const notifications = Object.fromEntries(kinds.map(({ kind }) => [kind, settings[kind] !== false]));
      const { preferences: next } = await updatePreferences({ notifications, timeZone: timeZone || null });
      setSettings(next.notifications);
      setTimeZone(next.timeZone ?? '');
      setNotice('Your preferences were saved.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Notification preferences">
      <form onSubmit={save} className="space-y-4">
        <ErrorAlert error={errorSummary(error)} />
        <SuccessAlert>{notice}</SuccessAlert>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Notify me when</legend>
          {kinds.map(({ kind, label }) => (
            <label key={kind} className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={settings[kind] !== false} onChange={(e) => setSettings((s) => ({ ...s, [kind]: e.target.checked }))} />
              {label}
            </label>
          ))}
        </fieldset>
        <Field label="Time zone" error={fieldErrors(error).timeZone} hint="Decides when your daily summary arrives.">
          <select className={inputClass} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
            <option value="">Company default</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save preferences'}
        </Button>
      </form>
    </Card>
  );
}

/** The signed-in person's profile, password and notification preferences (Phase 10). */
export function ProfilePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    getProfile().then(setData).catch(setError);
  }, []);

  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Profile</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <DetailsCard profile={data.profile} />
          <PasswordCard />
        </div>
        <PreferencesCard kinds={data.notificationKinds} preferences={data.profile.preferences} />
      </div>
    </div>
  );
}
