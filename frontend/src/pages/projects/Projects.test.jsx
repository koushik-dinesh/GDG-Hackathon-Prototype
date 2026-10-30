import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import * as directoryApi from '../../api/directory.js';
import * as projectsApi from '../../api/projects.js';
import * as teamsApi from '../../api/teams.js';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { ProtectedRoute } from '../../auth/ProtectedRoute.jsx';
import { ProjectDetailPage } from './ProjectDetail.jsx';
import { ProjectsPage } from './Projects.jsx';

vi.mock('../../api/auth.js');
vi.mock('../../api/projects.js');
vi.mock('../../api/directory.js');
vi.mock('../../api/teams.js');

const USERS = {
  admin: { id: 1, email: 'ada@example.test', fullName: 'Ada Admin', role: 'admin', isActive: true },
  manager: { id: 2, email: 'mia@example.test', fullName: 'Mia Manager', role: 'manager', isActive: true },
  employee: { id: 3, email: 'eve@example.test', fullName: 'Eve Employee', role: 'employee', isActive: true },
};

const person = (u) => ({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, isActive: true, addedAt: null, addedBy: null });

const project = (o = {}) => ({
  id: 7,
  name: 'Apollo',
  description: 'Moon launch',
  status: 'active',
  ownerUserId: 2,
  owner: { id: 2, fullName: 'Mia Manager', email: 'mia@example.test', isActive: true },
  startDate: '2026-11-01',
  targetDate: '2027-03-31',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z',
  memberCount: 2,
  meetingCount: 1,
  openTaskCount: 1,
  ...o,
});

const managerPermissions = { canEdit: true, canChangeStatus: true, canManageMembers: true, canChangeOwner: false, canViewAllTasks: true, canLinkMeetings: false };
const readOnlyPermissions = { canEdit: false, canChangeStatus: false, canManageMembers: false, canChangeOwner: false, canViewAllTasks: false, canLinkMeetings: false };

function renderAt(path, role) {
  authApi.me.mockResolvedValue({ user: USERS[role] });
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

function mockDetail({ permissions = managerPermissions, tasks, scope = 'all', overrides = {} } = {}) {
  projectsApi.getProject.mockResolvedValue({
    project: { ...project(overrides), members: [person(USERS.manager), { ...person(USERS.employee), isActive: overrides.inactiveMember ? false : true }], permissions },
  });
  projectsApi.getProjectMeetings.mockResolvedValue({
    meetings: [{ id: 11, title: 'Apollo kickoff', status: 'approved', scheduledAt: '2026-11-02T09:00:00Z', createdAt: '2026-10-01T00:00:00Z', itemCount: 2, approvedCount: 1 }],
  });
  projectsApi.getProjectTasks.mockResolvedValue({
    scope,
    tasks: tasks ?? [
      {
        id: 21, title: 'Book the launch pad', priority: 'high', reviewStatus: 'approved', taskStatus: 'in_progress', dueDate: '2026-11-20',
        assignee: { id: 3, fullName: 'Eve Employee', email: 'eve@example.test', isActive: true }, meeting: { id: 11, title: 'Apollo kickoff' },
      },
      {
        id: 22, title: 'Draft the budget', priority: 'medium', reviewStatus: 'pending', taskStatus: 'todo', dueDate: null,
        assignee: null, meeting: { id: 11, title: 'Apollo kickoff' },
      },
    ],
  });
  projectsApi.getProjectActivity.mockResolvedValue({
    activity: [{ id: 1, action: 'project.created', at: '2026-10-01T10:00:00Z', actor: { id: 2, fullName: 'Mia Manager' }, before: null, after: {} }],
  });
  directoryApi.listPeople.mockResolvedValue({ users: [USERS.admin, USERS.manager, USERS.employee, { id: 4, fullName: 'Eli New', email: 'eli@example.test', role: 'employee' }] });
  teamsApi.listTeams.mockResolvedValue({ teams: [{ id: 5, name: 'Ops', memberCount: 3 }], permissions: { canCreate: true } });
}

afterEach(cleanup);

describe('Projects list', () => {
  it('lists projects with their owner, counts and status', async () => {
    projectsApi.listProjects.mockResolvedValue({ projects: [project(), project({ id: 8, name: 'Borealis', status: 'planning', memberCount: 0 })], permissions: { canCreate: true } });
    renderAt('/projects', 'manager');
    const row = (await screen.findByRole('link', { name: 'Apollo' })).closest('tr');
    expect(within(row).getByText('Mia Manager')).toBeTruthy();
    expect(within(row).getByText('active')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Borealis' })).toBeTruthy();
    expect(projectsApi.listProjects).toHaveBeenCalledWith({ status: undefined, includeArchived: false });
  });

  it('shows an empty state and an error state', async () => {
    projectsApi.listProjects.mockResolvedValueOnce({ projects: [], permissions: { canCreate: false } });
    renderAt('/projects', 'employee');
    expect(await screen.findByText('You are not a member of any project yet.')).toBeTruthy();
    cleanup();
    projectsApi.listProjects.mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.'));
    renderAt('/projects', 'employee');
    expect(await screen.findByText(/Could not load projects: Cannot reach the server/)).toBeTruthy();
  });

  it('hides “New project” from employees', async () => {
    projectsApi.listProjects.mockResolvedValue({ projects: [project()], permissions: { canCreate: false } });
    renderAt('/projects', 'employee');
    await screen.findByRole('link', { name: 'Apollo' });
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('a manager creates a project (owned by themselves) and is taken to it', async () => {
    projectsApi.listProjects.mockResolvedValue({ projects: [], permissions: { canCreate: true } });
    projectsApi.createProject.mockResolvedValue({ project: { ...project({ id: 9, name: 'Comet' }) } });
    mockDetail({ overrides: { id: 9, name: 'Comet' } });
    renderAt('/projects', 'manager');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    expect(screen.queryByLabelText('Owner')).toBeNull();
    await user.type(screen.getByLabelText('Name'), '  Comet ');
    await user.type(screen.getByLabelText('Start date'), '2026-12-01');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(projectsApi.createProject).toHaveBeenCalledWith({ name: 'Comet', description: null, startDate: '2026-12-01', targetDate: null, status: 'planning' });
    expect(await screen.findByRole('heading', { name: 'Comet' })).toBeTruthy();
  });

  it('validates the form and shows server field errors', async () => {
    projectsApi.listProjects.mockResolvedValue({ projects: [], permissions: { canCreate: true } });
    projectsApi.createProject.mockRejectedValue(new ApiError(409, 'CONFLICT', 'A project with this name already exists', [{ field: 'name', message: 'Already in use' }]));
    renderAt('/projects', 'manager');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(screen.getByText('Required')).toBeTruthy();
    expect(projectsApi.createProject).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Name'), 'Apollo');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Already in use')).toBeTruthy();
  });

  it('an admin can choose the owner from admins and managers', async () => {
    projectsApi.listProjects.mockResolvedValue({ projects: [], permissions: { canCreate: true } });
    directoryApi.listPeople.mockResolvedValue({ users: [USERS.admin, USERS.manager, USERS.employee] });
    renderAt('/projects', 'admin');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const owner = await screen.findByLabelText('Owner');
    const options = within(owner).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Me', 'Mia Manager (manager)']);
  });
});

describe('Project detail', () => {
  it('renders details, members, meetings, tasks (with review and task status) and activity', async () => {
    mockDetail();
    renderAt('/projects/7', 'manager');
    expect(await screen.findByRole('heading', { name: 'Apollo' })).toBeTruthy();
    expect(screen.getByText('Moon launch')).toBeTruthy();
    expect(screen.getByText('Members (2)')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();

    const taskRow = (await screen.findByText('Book the launch pad')).closest('tr');
    expect(within(taskRow).getByText('Eve Employee')).toBeTruthy();
    expect(within(taskRow).getByText('Approved')).toBeTruthy();
    expect(within(taskRow).getByText('In progress')).toBeTruthy();
    expect(within(taskRow).getByText('high')).toBeTruthy();
    expect(within(taskRow).getByText('Apollo kickoff')).toBeTruthy();
    const pendingRow = screen.getByText('Draft the budget').closest('tr');
    expect(within(pendingRow).getByText('Pending review')).toBeTruthy();
    expect(within(pendingRow).getByText('Unassigned')).toBeTruthy();

    expect(screen.getByText('1/2 items approved')).toBeTruthy();
    expect(await screen.findByText('created the project')).toBeTruthy();
  });

  it('employees see a read-only page with only their own tasks', async () => {
    mockDetail({ permissions: readOnlyPermissions, scope: 'mine', tasks: [] });
    renderAt('/projects/7', 'employee');
    await screen.findByRole('heading', { name: 'Apollo' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive project' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText('Person to add')).toBeNull();
    expect(await screen.findByText('Showing only the tasks assigned to you.')).toBeTruthy();
    expect(directoryApi.listPeople).not.toHaveBeenCalled();
    // Meeting titles are not links for non-admins (the meeting pages are admin-only).
    expect(screen.queryByRole('link', { name: 'Apollo kickoff' })).toBeNull();
  });

  it('shows a not-found message for projects the user cannot see', async () => {
    projectsApi.getProject.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project not found'));
    projectsApi.getProjectMeetings.mockResolvedValue({ meetings: [] });
    renderAt('/projects/99', 'employee');
    expect(await screen.findByText('Project not found.')).toBeTruthy();
  });

  it('the owner adds a member and removes one', async () => {
    mockDetail();
    projectsApi.addProjectMembers.mockResolvedValue({
      added: [4],
      members: [person(USERS.manager), person(USERS.employee), { id: 4, fullName: 'Eli New', email: 'eli@example.test', role: 'employee', isActive: true }],
    });
    projectsApi.removeProjectMember.mockResolvedValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/projects/7', 'manager');
    const user = userEvent.setup();

    const select = await screen.findByLabelText('Person to add');
    await screen.findByRole('option', { name: 'Eli New (eli@example.test)' });
    // Existing members are not offered again.
    expect(within(select).queryByRole('option', { name: /Eve Employee/ })).toBeNull();
    await user.selectOptions(select, '4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(projectsApi.addProjectMembers).toHaveBeenCalledWith(7, { userIds: [4] });
    expect(await screen.findByText('Members (3)')).toBeTruthy();

    // The owner has no remove button; others do.
    expect(screen.queryByRole('button', { name: 'Remove Mia Manager' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove Eve Employee' }));
    expect(projectsApi.removeProjectMember).toHaveBeenCalledWith(7, 3);
    expect(await screen.findByText('Members (2)')).toBeTruthy();
  });

  it('adds a whole team', async () => {
    mockDetail();
    projectsApi.addProjectMembers.mockResolvedValue({ added: [4], members: [person(USERS.manager), person(USERS.employee)] });
    renderAt('/projects/7', 'manager');
    const user = userEvent.setup();
    const teamSelect = await screen.findByLabelText('Team to add');
    await user.selectOptions(teamSelect, '5');
    await user.click(screen.getByRole('button', { name: 'Add team' }));
    expect(projectsApi.addProjectMembers).toHaveBeenCalledWith(7, { teamId: 5 });
  });

  it('shows membership errors from the server', async () => {
    mockDetail();
    projectsApi.addProjectMembers.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Only the project owner or an admin can change this project'));
    renderAt('/projects/7', 'manager');
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Eli New (eli@example.test)' });
    await user.selectOptions(screen.getByLabelText('Person to add'), '4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Only the project owner or an admin/);
  });

  it('marks inactive members', async () => {
    mockDetail({ overrides: { inactiveMember: true } });
    renderAt('/projects/7', 'manager');
    expect(await screen.findByText('inactive')).toBeTruthy();
  });

  it('archives and reactivates; an archived project is read-only', async () => {
    mockDetail();
    projectsApi.updateProject.mockImplementation(async (id, body) => ({
      project: { ...project({ status: body.status }), members: [person(USERS.manager)], permissions: managerPermissions },
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/projects/7', 'manager');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Archive project' }));
    expect(projectsApi.updateProject).toHaveBeenCalledWith(7, { status: 'archived' });
    expect(await screen.findByText(/This project is archived and read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByLabelText('Person to add')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reactivate project' }));
    expect(projectsApi.updateProject).toHaveBeenLastCalledWith(7, { status: 'active' });
    expect(await screen.findByText('Status changed to Active.')).toBeTruthy();
  });

  it('edits the project details', async () => {
    mockDetail();
    projectsApi.updateProject.mockResolvedValue({
      project: { ...project({ description: 'Updated text' }), members: [person(USERS.manager)], permissions: managerPermissions },
    });
    renderAt('/projects/7', 'manager');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Updated text');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(projectsApi.updateProject).toHaveBeenCalledWith(7, {
      name: 'Apollo', description: 'Updated text', startDate: '2026-11-01', targetDate: '2027-03-31',
    });
    expect(await screen.findByText('Project saved.')).toBeTruthy();
  });
});
