import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { acceptInvitation, verifyInvitation } from '../api/auth.js';
import { Button, ErrorAlert, Field, inputClass } from '../components/ui.jsx';
import { fieldErrorsFrom } from '../utils/format.js';

const MIN_LENGTH = 12;
const MAX_BYTES = 72;

// The invitation email links to /accept-invitation#token=... The token is in the fragment so it
// is never sent to a server or written to request logs; it is read once and removed from the URL.
function takeTokenFromUrl() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('token');
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

export function AcceptInvitationPage() {
  const navigate = useNavigate();
  const [token] = useState(takeTokenFromUrl);
  const [invitation, setInvitation] = useState(null);
  const [loadError, setLoadError] = useState(token ? null : { code: 'INVALID_INVITATION' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    verifyInvitation(token)
      .then((data) => setInvitation(data.invitation))
      .catch(setLoadError);
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    const clientErrors = {};
    if (password.length < MIN_LENGTH) clientErrors.password = `Use at least ${MIN_LENGTH} characters`;
    else if (new TextEncoder().encode(password).length > MAX_BYTES) clientErrors.password = `Use at most ${MAX_BYTES} characters`;
    if (confirm !== password) clientErrors.confirm = 'The passwords do not match';
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) return;

    setSaving(true);
    setError(null);
    try {
      await acceptInvitation(token, password);
      navigate('/login', { replace: true, state: { activated: true, email: invitation.email } });
    } catch (err) {
      if (err.code === 'INVALID_INVITATION' || err.code === 'INVITATION_EXPIRED') {
        setLoadError(err);
      } else {
        setErrors(fieldErrorsFrom(err));
        setError(err.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : err);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Activate your account</h1>
          <p className="mt-1 text-sm text-slate-500">WorkAgent</p>
        </div>

        {loadError ? (
          <InvitationProblem error={loadError} />
        ) : !invitation ? (
          <p className="text-sm text-slate-500">Checking your invitation…</p>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <p className="text-sm text-slate-600">
              Welcome, <span className="font-medium text-slate-900">{invitation.fullName}</span>. Choose a password for{' '}
              <span className="font-medium text-slate-900">{invitation.email}</span>.
            </p>
            <ErrorAlert error={error} />
            <Field label="New password" error={errors.password} hint={`At least ${MIN_LENGTH} characters.`}>
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Confirm password" error={errors.confirm}>
              <input
                className={inputClass}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={saving} className="w-full">
              {saving ? 'Activating…' : 'Activate account'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function InvitationProblem({ error }) {
  const message =
    error.code === 'INVITATION_EXPIRED'
      ? 'This invitation has expired. Ask your administrator to send a new one.'
      : error.code === 'INVALID_INVITATION'
        ? 'This invitation link is invalid or has already been used. If you already set your password, sign in instead.'
        : error.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : `Could not check the invitation: ${error.message}`;
  return (
    <div className="space-y-4">
      <ErrorAlert error={message} />
      <Link to="/login" className="block text-center text-sm font-medium text-slate-900 underline">
        Go to sign in
      </Link>
    </div>
  );
}
