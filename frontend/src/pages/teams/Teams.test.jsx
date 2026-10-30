import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import * as directoryApi from '../../api/directory.js';
import * as teamsApi from '../../api/teams.js';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { ProtectedRoute } from '../../auth/ProtectedRoute.jsx';
import { TeamsPage } from './Teams.jsx';

vi.mock('../../api/auth.js');
vi.mock('../../api/teams.js');
vi.mock('../../api/directory.js');

const USERS = {
  admin: { id: 1, email: 'ada@example.test', fullName: 'Ada Admin', role: 'admin', isActive: true },
  manager: { id: 2, email: 'mia@example.test', fullName: 'Mia Manager', role: 'manager', isActive: true },
  employee: { id: 3, email: 'eve@example.test', fullName: 'Eve Employee', role: 'employee', isActive: true },
};
const manage = { canEdit: true, canManageMembers: true, canChangeLead: false };
const readOnly = { canEdit: false, canManageMembers: false, canChangeLead: false };
const team = (o = {}) => ({
  id: 5, name: 'Platform', description: 'Infra', leadUserId: 2, lead: { id: 2, fullName: 'Mia Manager' }, memberCount: 1, permissions: manage, ...o,
});
const member = (u, o = {}) => ({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, isActive: true, ...o });

// Same guard as the app's router: the page renders once the session is known.
function Page() {
  return (
    <AuthProvider>
      <MemoryRouter initialEntries={['/teams']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/teams" element={<TeamsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

function renderAs(role, { teams = [team()], canCreate = true } = {}) {
  authApi.me.mockResolvedValue({ user: USERS[role] });
  teamsApi.listTeams.mockResolvedValue({ teams, permissions: { canCreate } });
  directoryApi.listPeople.mockResolvedValue({ users: [USERS.admin, USERS.manager, USERS.employee, { id: 4, fullName: 'Eli New', email: 'eli@example.test', role: 'employee' }] });
  render(
    <Page />,
  );
}

afterEach(cleanup);

describe('Teams page', () => {
  it('lists teams with lead and member count', async () => {
    renderAs('manager');
    expect(await screen.findByText('Platform')).toBeTruthy();
    expect(screen.getByText('Lead: Mia Manager · 1 member')).toBeTruthy();
  });

  it('a manager creates a team they will lead', async () => {
    renderAs('manager', { teams: [] });
    teamsApi.createTeam.mockResolvedValue({ team: team({ id: 6, name: 'Design', memberCount: 0, members: [] }) });
    const user = userEvent.setup();
    expect(await screen.findByText('You will lead this team.')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Design');
    await user.click(screen.getByRole('button', { name: 'Create team' }));
    expect(teamsApi.createTeam).toHaveBeenCalledWith({ name: 'Design', description: null });
    expect(await screen.findByText('Team Design created.')).toBeTruthy();
  });

  it('an admin can pick a lead from admins and managers', async () => {
    renderAs('admin', { teams: [] });
    const lead = await screen.findByLabelText('Lead');
    await screen.findByRole('option', { name: 'Mia Manager' });
    expect(within(lead).getAllByRole('option').map((o) => o.textContent)).toEqual(['No lead', 'Ada Admin', 'Mia Manager']);
  });

  it('employees see their teams read-only, without create, edit or member controls', async () => {
    renderAs('employee', { teams: [team({ permissions: readOnly })], canCreate: false });
    teamsApi.getTeam.mockResolvedValue({ team: { ...team({ permissions: readOnly }), members: [member(USERS.employee)] } });
    const user = userEvent.setup();
    await screen.findByText('Platform');
    expect(screen.queryByRole('button', { name: 'Create team' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show members' }));
    expect(await screen.findByText('Eve Employee')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByLabelText('Person to add to Platform')).toBeNull();
    expect(directoryApi.listPeople).not.toHaveBeenCalled();
  });

  it('the lead adds and removes members; inactive members are marked', async () => {
    renderAs('manager');
    teamsApi.getTeam.mockResolvedValue({ team: { ...team(), members: [member(USERS.employee), member({ id: 9, fullName: 'Gone Gus', email: 'g@example.test', role: 'employee' }, { isActive: false })] } });
    teamsApi.addTeamMembers.mockResolvedValue({ team: { ...team(), members: [member(USERS.employee), member({ id: 4, fullName: 'Eli New', email: 'eli@example.test', role: 'employee' })] } });
    teamsApi.removeTeamMember.mockResolvedValue(null);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Show members' }));
    expect(await screen.findByText('inactive')).toBeTruthy();
    const select = screen.getByLabelText('Person to add to Platform');
    await screen.findByRole('option', { name: 'Eli New (eli@example.test)' });
    await user.selectOptions(select, '4');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(teamsApi.addTeamMembers).toHaveBeenCalledWith(5, [4]);
    expect(await screen.findByText('Eli New')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove Eli New from Platform' }));
    expect(teamsApi.removeTeamMember).toHaveBeenCalledWith(5, 4);
  });

  it('shows an error when loading fails', async () => {
    authApi.me.mockResolvedValue({ user: USERS.manager });
    teamsApi.listTeams.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong'));
    directoryApi.listPeople.mockResolvedValue({ users: [] });
    render(<Page />);
    expect(await screen.findByText('Could not load teams: Something went wrong')).toBeTruthy();
  });
});
