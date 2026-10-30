import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { listPeople } from '../../api/directory.js';
import {
  addProjectMembers,
  getProject,
  getProjectActivity,
  getProjectMeetings,
  getProjectTasks,
  removeProjectMember,
  updateProject,
} from '../../api/projects.js';
import { listTeams } from '../../api/teams.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PRIORITY_STYLE, TaskStatusBadge } from '../../components/tasks/TaskStatus.jsx';
import { Button, Card, ErrorAlert, Loading, StatusBadge, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDate, formatDateTime } from '../../utils/format.js';
import { ProjectForm } from './ProjectForm.jsx';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, REVIEW_STATUS_LABEL, describeActivity } from './projectLabels.js';

export function ProjectDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [people, setPeople] = useState(null); // directory, only for people who manage the project
  // Bumped after changes that show up in the activity list.
  const [activityKey, setActivityKey] = useState(0);

  const load = useCallback(() => {
    setError(null);
    return getProject(id)
      .then(({ project: p }) => setProject(p))
      .catch(setError);
  }, [id]);
  useEffect(() => {
    setProject(null);
    load();
  }, [load]);

  const perms = project?.permissions;
  const needsPeople = Boolean(perms?.canManageMembers || (editing && perms?.canChangeOwner));
  useEffect(() => {
    if (!needsPeople || people) return;
    listPeople()
      .then((d) => setPeople(d.users))
      .catch(() => setPeople([]));
  }, [needsPeople, people]);

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorAlert error={error.status === 404 ? 'Project not found.' : `Could not load project: ${error.message}`} />
      </div>
    );
  }
  if (!project) return <Loading />;

  const archived = project.status === 'archived';
  const changed = (updated, message) => {
    setProject(updated);
    setNotice(message);
    setActivityKey((k) => k + 1);
  };

  async function save(values) {
    const { project: updated } = await updateProject(project.id, values);
    setEditing(false);
    changed(updated, 'Project saved.');
  }

  return (
    <div className="space-y-6">
      <div>
        <BackLink />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <StatusBadge status={project.status} />
        </div>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>
      {archived && (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          This project is archived and read-only{perms.canChangeStatus ? '. Reactivate it to make changes.' : '.'}
        </p>
      )}

      <Card
        title="Details"
        actions={
          perms.canEdit && !editing && !archived && (
            <Button variant="secondary" onClick={() => { setNotice(''); setEditing(true); }}>
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          perms.canChangeOwner && !people ? (
            <Loading label="Loading people…" />
          ) : (
            <ProjectForm
              initial={project}
              submitLabel="Save changes"
              owners={perms.canChangeOwner ? people.filter((p) => ['admin', 'manager'].includes(p.role)) : undefined}
              onSubmit={save}
              onCancel={() => setEditing(false)}
            />
          )
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Owner">
              {project.owner.fullName}
              {!project.owner.isActive && <span className="ml-1 text-xs text-red-600">(inactive)</span>}
            </Detail>
            <Detail label="Dates">
              {project.startDate ? formatDate(project.startDate) : 'No start date'} → {project.targetDate ? formatDate(project.targetDate) : 'no target date'}
            </Detail>
            <div className="sm:col-span-2">
              <Detail label="Description">{project.description || <span className="text-slate-400">No description</span>}</Detail>
            </div>
            <Detail label="Created">{formatDateTime(project.createdAt)}</Detail>
            <Detail label="Last updated">{formatDateTime(project.updatedAt)}</Detail>
          </dl>
        )}
      </Card>

      {perms.canChangeStatus && <StatusControl project={project} onChanged={changed} />}

      <MembersCard
        project={project}
        people={people}
        canManage={perms.canManageMembers && !archived}
        onChanged={(members, message) => changed({ ...project, members, memberCount: members.length }, message)}
        currentUserId={user.id}
      />
      <MeetingsCard projectId={project.id} linkToMeetings={user.role === 'admin'} />
      <TasksCard projectId={project.id} />
      <ActivityCard projectId={project.id} refreshKey={activityKey} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-900">
      ← Projects
    </Link>
  );
}

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-900">{children}</dd>
    </div>
  );
}

function StatusControl({ project, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const archived = project.status === 'archived';

  async function setStatus(status) {
    if (status === project.status) return;
    if (status === 'archived' && !window.confirm(`Archive ${project.name}? It becomes read-only and is hidden from the default project list.`)) return;
    setBusy(true);
    setError(null);
    try {
      const { project: updated } = await updateProject(project.id, { status });
      onChanged(updated, `Status changed to ${PROJECT_STATUS_LABEL[status]}.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Status">
      <div className="flex flex-wrap items-center gap-3">
        {!archived && (
          <select
            className={`${inputClass} max-w-[12rem]`}
            value={project.status}
            disabled={busy}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Project status"
          >
            {PROJECT_STATUSES.filter((s) => s !== 'archived').map((s) => (
              <option key={s} value={s}>
                {PROJECT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        )}
        {archived ? (
          <Button onClick={() => setStatus('active')} disabled={busy}>
            Reactivate project
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setStatus('archived')} disabled={busy}>
            Archive project
          </Button>
        )}
      </div>
      <ErrorAlert error={error} className="mt-3" />
    </Card>
  );
}

function MembersCard({ project, people, canManage, onChanged, currentUserId }) {
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teams, setTeams] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!canManage) return;
    listTeams()
      .then((d) => setTeams(d.teams))
      .catch(() => setTeams([]));
  }, [canManage]);

  const memberIds = new Set(project.members.map((m) => m.id));
  const candidates = (people ?? []).filter((p) => !memberIds.has(p.id));

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const add = (body, label) =>
    run(async () => {
      const { members, added } = await addProjectMembers(project.id, body);
      onChanged(members, added.length ? `${label}: ${added.length} added.` : 'Everyone was already a member.');
      setUserId('');
      setTeamId('');
    });

  const remove = (member) =>
    run(async () => {
      if (!window.confirm(`Remove ${member.fullName} from ${project.name}? Their tasks and meeting history stay as they are.`)) return;
      await removeProjectMember(project.id, member.id);
      onChanged(project.members.filter((m) => m.id !== member.id), `${member.fullName} removed.`);
    });

  return (
    <Card title={`Members (${project.members.length})`}>
      {project.members.length === 0 ? (
        <p className="text-sm text-slate-500">No members yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {project.members.map((m) => (
            <li key={m.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${m.isActive ? '' : 'opacity-70'}`}>
              <div>
                <span className="font-medium text-slate-900">{m.fullName}</span>
                {m.id === currentUserId && <span className="ml-1 text-xs text-slate-500">(you)</span>}
                <span className="ml-2 text-slate-500">{m.email}</span>
                <span className="ml-2 inline-flex gap-1 text-xs">
                  {m.id === project.ownerUserId && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-white">owner</span>}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 capitalize text-slate-700">{m.role}</span>
                  {!m.isActive && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">inactive</span>}
                </span>
              </div>
              {canManage && m.id !== project.ownerUserId && (
                <Button variant="link" onClick={() => remove(m)} disabled={busy} aria-label={`Remove ${m.fullName}`}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-100 pt-4">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (userId) add({ userIds: [Number(userId)] }, 'Member added');
            }}
          >
            <select className={`${inputClass} max-w-xs`} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person to add" disabled={!people}>
              <option value="">{people ? 'Add a person…' : 'Loading people…'}</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName} ({p.email})
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary" disabled={busy || !userId}>
              Add
            </Button>
          </form>
          {teams?.length > 0 && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (teamId) add({ teamId: Number(teamId) }, 'Team added');
              }}
            >
              <select className={`${inputClass} max-w-xs`} value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team to add">
                <option value="">Add a whole team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.memberCount})
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary" disabled={busy || !teamId}>
                Add team
              </Button>
            </form>
          )}
        </div>
      )}
      <ErrorAlert error={error} className="mt-3" />
    </Card>
  );
}

// Loads one project sub-resource with loading/error states.
function useProjectList(fetcher, projectId, refreshKey = 0) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetcher(projectId)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [fetcher, projectId, refreshKey]);
  return { data, error };
}

function MeetingsCard({ projectId, linkToMeetings }) {
  const { data, error } = useProjectList(getProjectMeetings, projectId);
  return (
    <Card title="Meetings">
      {error && <ErrorAlert error={`Could not load meetings: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.meetings.length === 0 && (
        <p className="text-sm text-slate-500">
          No meetings in this project yet.{linkToMeetings && ' Choose this project in a meeting’s details to add it.'}
        </p>
      )}
      {data?.meetings.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {data.meetings.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div>
                {linkToMeetings ? (
                  <Link to={`/admin/meetings/${m.id}`} className="font-medium text-slate-900 hover:underline">
                    {m.title}
                  </Link>
                ) : (
                  <span className="font-medium text-slate-900">{m.title}</span>
                )}
                <span className="ml-2 text-slate-500">{formatDateTime(m.scheduledAt ?? m.createdAt)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>
                  {m.approvedCount}/{m.itemCount} items approved
                </span>
                <StatusBadge status={m.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TasksCard({ projectId }) {
  const { data, error } = useProjectList(getProjectTasks, projectId);
  return (
    <Card title="Tasks">
      {data?.scope === 'mine' && <p className="mb-3 text-xs text-slate-500">Showing only the tasks assigned to you.</p>}
      {error && <ErrorAlert error={`Could not load tasks: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.tasks.length === 0 && (
        <EmptyState title="No tasks">Action items from this project’s meetings appear here.</EmptyState>
      )}
      {data?.tasks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Title</th>
                <th className="py-2 pr-4 font-medium">Assignee</th>
                <th className="py-2 pr-4 font-medium">Due</th>
                <th className="py-2 pr-4 font-medium">Priority</th>
                <th className="py-2 pr-4 font-medium">Review</th>
                <th className="py-2 pr-4 font-medium">Task status</th>
                <th className="py-2 pr-4 font-medium">Source meeting</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.tasks.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 pr-4 font-medium text-slate-900">{t.title}</td>
                  <td className="py-2 pr-4 text-slate-600">
                    {t.assignee ? t.assignee.fullName : <span className="text-slate-400">Unassigned</span>}
                    {t.assignee && !t.assignee.isActive && <span className="ml-1 text-xs text-red-600">(inactive)</span>}
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{t.dueDate ? formatDate(t.dueDate) : '—'}</td>
                  <td className="py-2 pr-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${PRIORITY_STYLE[t.priority]}`}>{t.priority}</span>
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{REVIEW_STATUS_LABEL[t.reviewStatus]}</td>
                  <td className="py-2 pr-4">
                    <TaskStatusBadge status={t.taskStatus} />
                  </td>
                  <td className="py-2 pr-4 text-slate-600">{t.meeting.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ActivityCard({ projectId, refreshKey }) {
  const { data, error } = useProjectList(getProjectActivity, projectId, refreshKey);
  return (
    <Card title="Activity">
      {error && <ErrorAlert error={`Could not load activity: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.activity.length === 0 && <p className="text-sm text-slate-500">No activity yet.</p>}
      {data?.activity.length > 0 && (
        <ul className="space-y-2 text-sm">
          {data.activity.map((a) => {
            const { what, detail } = describeActivity(a);
            return (
              <li key={a.id} className="flex flex-wrap gap-x-2 text-slate-600">
                <span className="text-slate-400">{formatDateTime(a.at)}</span>
                <span>
                  <span className="font-medium text-slate-900">{a.actor?.fullName ?? 'System'}</span> {what}
                  {detail && <span className="text-slate-500"> · {detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
