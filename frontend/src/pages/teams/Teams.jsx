import { useCallback, useEffect, useState } from 'react';
import { listPeople } from '../../api/directory.js';
import { addTeamMembers, createTeam, getTeam, listTeams, removeTeamMember, updateTeam } from '../../api/teams.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { errorSummary, fieldErrorsFrom } from '../../utils/format.js';

export function TeamsPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [people, setPeople] = useState(null);

  const load = useCallback(
    () =>
      listTeams()
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Only admins and managers can read the directory (needed to pick leads and members).
  const canUseDirectory = ['admin', 'manager'].includes(user.role);
  useEffect(() => {
    if (!canUseDirectory) return;
    listPeople()
      .then((d) => setPeople(d.users))
      .catch(() => setPeople([]));
  }, [canUseDirectory]);

  const replaceTeam = (team) => setData((d) => ({ ...d, teams: d.teams.map((t) => (t.id === team.id ? team : t)) }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Teams</h1>
        <p className="mt-1 text-sm text-slate-500">
          Groups of people. Add a whole team to a project from the project page.
        </p>
      </div>

      {data?.permissions?.canCreate && (
        <CreateTeamForm
          isAdmin={user.role === 'admin'}
          people={people}
          onCreated={(team) => {
            setData((d) => ({ ...d, teams: [...d.teams, team].sort((a, b) => a.name.localeCompare(b.name)) }));
            setNotice(`Team ${team.name} created.`);
          }}
        />
      )}
      <SuccessAlert>{notice}</SuccessAlert>

      {error && <ErrorAlert error={`Could not load teams: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.teams.length === 0 && (
        <EmptyState title="No teams">
          {data.permissions.canCreate ? 'Create the first team above.' : 'You are not in any team yet.'}
        </EmptyState>
      )}
      {data?.teams.length > 0 && (
        <div className="space-y-3">
          {data.teams.map((t) => (
            <TeamRow key={t.id} team={t} people={people} isAdmin={user.role === 'admin'} onChange={replaceTeam} />
          ))}
        </div>
      )}
    </div>
  );
}

const leadCandidates = (people) => (people ?? []).filter((p) => ['admin', 'manager'].includes(p.role));

function CreateTeamForm({ isAdmin, people, onCreated }) {
  const empty = { name: '', description: '', leadUserId: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setErrors({ name: 'Required' });
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      const { team } = await createTeam({
        name: form.name.trim(),
        description: form.description.trim() || null,
        ...(isAdmin && form.leadUserId && { leadUserId: Number(form.leadUserId) }),
      });
      onCreated(team);
      setForm(empty);
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      setError(errorSummary(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="New team">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <ErrorAlert error={error} />
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_14rem_auto] sm:items-start">
          <Field label="Name" error={errors.name}>
            <input className={inputClass} value={form.name} onChange={set('name')} maxLength={200} />
          </Field>
          <Field label="Description" error={errors.description}>
            <input className={inputClass} value={form.description} onChange={set('description')} maxLength={5000} />
          </Field>
          {isAdmin ? (
            <Field label="Lead" error={errors.leadUserId}>
              <select className={inputClass} value={form.leadUserId} onChange={set('leadUserId')}>
                <option value="">No lead</option>
                {leadCandidates(people).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-xs text-slate-500 sm:mt-7">You will lead this team.</p>
          )}
          <Button type="submit" disabled={saving} className="sm:mt-6">
            {saving ? 'Creating…' : 'Create team'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TeamRow({ team, people, isAdmin, onChange }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const canManage = team.permissions?.canManageMembers;

  useEffect(() => {
    if (!open || detail) return;
    getTeam(team.id)
      .then((d) => setDetail(d.team))
      .catch(setError);
  }, [open, detail, team.id]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorSummary(err));
    } finally {
      setBusy(false);
    }
  }

  const apply = (updated) => {
    setDetail(updated);
    onChange({ ...team, ...updated, memberCount: updated.members.length });
  };

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const { team: updated } = await updateTeam(team.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        ...(isAdmin && { leadUserId: form.leadUserId ? Number(form.leadUserId) : null }),
      });
      apply(updated);
      setEditing(false);
    });
  };

  const add = (e) => {
    e.preventDefault();
    if (!userId) return;
    run(async () => {
      const { team: updated } = await addTeamMembers(team.id, [Number(userId)]);
      apply(updated);
      setUserId('');
    });
  };

  const remove = (member) =>
    run(async () => {
      await removeTeamMember(team.id, member.id);
      apply({ ...detail, members: detail.members.filter((m) => m.id !== member.id) });
    });

  const memberIds = new Set(detail?.members.map((m) => m.id) ?? []);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      {editing ? (
        <form onSubmit={save} noValidate className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Description">
              <input className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            {isAdmin && (
              <Field label="Lead">
                <select className={inputClass} value={form.leadUserId} onChange={(e) => setForm({ ...form, leadUserId: e.target.value })}>
                  <option value="">No lead</option>
                  {leadCandidates(people).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium text-slate-900">{team.name}</p>
            {team.description && <p className="text-sm text-slate-500">{team.description}</p>}
            <p className="mt-1 text-xs text-slate-500">
              Lead: {team.lead ? team.lead.fullName : 'none'} · {team.memberCount} member{team.memberCount === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex gap-2">
            {team.permissions?.canEdit && (
              <Button
                variant="secondary"
                onClick={() => {
                  setForm({ name: team.name, description: team.description ?? '', leadUserId: team.leadUserId ? String(team.leadUserId) : '' });
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? 'Hide members' : 'Show members'}
            </Button>
          </div>
        </div>
      )}

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {!detail && !error && <Loading />}
          {detail && detail.members.length === 0 && <p className="text-sm text-slate-500">No members yet.</p>}
          {detail?.members.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {detail.members.map((m) => (
                <li key={m.id} className={`flex items-center justify-between gap-2 py-1.5 text-sm ${m.isActive ? '' : 'opacity-70'}`}>
                  <span>
                    <span className="font-medium text-slate-900">{m.fullName}</span>
                    <span className="ml-2 text-slate-500">{m.email}</span>
                    {!m.isActive && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">inactive</span>}
                  </span>
                  {canManage && (
                    <Button variant="link" onClick={() => remove(m)} disabled={busy} aria-label={`Remove ${m.fullName} from ${team.name}`}>
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && detail && (
            <form onSubmit={add} className="mt-3 flex items-center gap-2">
              <select className={`${inputClass} max-w-xs`} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label={`Person to add to ${team.name}`}>
                <option value="">Add a person…</option>
                {(people ?? [])
                  .filter((p) => !memberIds.has(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName} ({p.email})
                    </option>
                  ))}
              </select>
              <Button type="submit" variant="secondary" disabled={busy || !userId}>
                Add
              </Button>
            </form>
          )}
        </div>
      )}
      <ErrorAlert error={error} className="mt-2" />
    </div>
  );
}
