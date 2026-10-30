import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { listPeople } from '../../api/directory.js';
import { createProject, listProjects } from '../../api/projects.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading, StatusBadge, inputClass } from '../../components/ui.jsx';
import { formatDate } from '../../utils/format.js';
import { ProjectForm } from './ProjectForm.jsx';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from './projectLabels.js';

export function ProjectsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [owners, setOwners] = useState(null);

  const load = useCallback(() => {
    setError(null);
    listProjects({ status: status || undefined, includeArchived })
      .then(setData)
      .catch(setError);
  }, [status, includeArchived]);
  useEffect(() => {
    load();
  }, [load]);

  // Only admins pick another owner; managers always own what they create.
  useEffect(() => {
    if (!creating || user.role !== 'admin' || owners) return;
    listPeople()
      .then((d) => setOwners(d.users.filter((p) => ['admin', 'manager'].includes(p.role) && p.id !== user.id)))
      .catch(() => setOwners([]));
  }, [creating, user, owners]);

  async function handleCreate(values) {
    const { project } = await createProject(values);
    navigate(`/projects/${project.id}`);
  }

  const canCreate = data?.permissions?.canCreate;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-slate-500">
            {user.role === 'admin' ? 'Every project in the company.' : 'Projects you own or are a member of.'}
          </p>
        </div>
        {canCreate && !creating && <Button onClick={() => setCreating(true)}>New project</Button>}
      </div>

      {creating && (
        <Card title="New project">
          {user.role === 'admin' && !owners ? (
            <Loading label="Loading people…" />
          ) : (
            <ProjectForm
              submitLabel="Create project"
              withStatus
              owners={user.role === 'admin' ? owners : undefined}
              onSubmit={handleCreate}
              onCancel={() => setCreating(false)}
            />
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select className={`${inputClass} max-w-[12rem]`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {!status && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Show archived
          </label>
        )}
      </div>

      {error && <ErrorAlert error={`Could not load projects: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.projects.length === 0 && (
        <EmptyState title="No projects">
          {canCreate ? 'Create the first project with “New project”.' : 'You are not a member of any project yet.'}
        </EmptyState>
      )}
      {data?.projects.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Owner</th>
                <th className="px-4 py-2 font-medium">Members</th>
                <th className="px-4 py-2 font-medium">Meetings</th>
                <th className="px-4 py-2 font-medium">Open tasks</th>
                <th className="px-4 py-2 font-medium">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.projects.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link to={`/projects/${p.id}`} className="font-medium text-slate-900 hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {p.owner.fullName}
                    {!p.owner.isActive && <span className="ml-1 text-xs text-red-600">(inactive)</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{p.memberCount}</td>
                  <td className="px-4 py-2 text-slate-600">{p.meetingCount}</td>
                  <td className="px-4 py-2 text-slate-600">{p.openTaskCount}</td>
                  <td className="px-4 py-2 text-slate-600">{p.targetDate ? formatDate(p.targetDate) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
