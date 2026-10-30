import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import * as usersApi from '../../api/users.js';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { UsersPage } from './Users.jsx';

vi.mock('../../api/auth.js');
vi.mock('../../api/users.js');

const admin = { id: 1, email: 'ada@example.test', fullName: 'Ada Admin', role: 'admin', isActive: true };
const row = (o) => ({ role: 'employee', isActive: true, hasPassword: true, aliases: [], invitation: null, createdAt: '2026-10-01T00:00:00Z', ...o });

async function renderPage(users) {
  authApi.me.mockResolvedValue({ user: admin });
  usersApi.listUsers.mockResolvedValue({ users });
  render(
    <AuthProvider>
      <UsersPage />
    </AuthProvider>,
  );
  await screen.findByText(users[0]?.fullName ?? 'No users');
}

const card = (name) => screen.getByText(name).closest('.rounded-xl');

afterEach(cleanup);

describe('Users page — invitations', () => {
  it('creates an employee and emails an invitation in one step', async () => {
    await renderPage([row({ ...admin })]);
    usersApi.createUser.mockResolvedValue({ user: row({ id: 5, email: 'ivy@example.test', fullName: 'Ivy Invitee', hasPassword: false }) });
    usersApi.sendInvitation.mockResolvedValue({ invitation: { id: 9, status: 'pending', expiresAt: '2026-11-01T00:00:00Z' } });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Full name'), 'Ivy Invitee');
    await user.type(screen.getByLabelText('Email'), 'ivy@example.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'manager');
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    expect(usersApi.createUser).toHaveBeenCalledWith({ fullName: 'Ivy Invitee', email: 'ivy@example.test', role: 'manager' });
    expect(usersApi.sendInvitation).toHaveBeenCalledWith(5);
    expect(await screen.findByText('Ivy Invitee added and an invitation was emailed to ivy@example.test.')).toBeTruthy();
    expect(within(card('Ivy Invitee')).getByText('invitation sent')).toBeTruthy();
  });

  it('keeps the new account and explains when the invitation email fails', async () => {
    await renderPage([row({ ...admin })]);
    usersApi.createUser.mockResolvedValue({ user: row({ id: 6, email: 'bob@example.test', fullName: 'Bob', hasPassword: false }) });
    usersApi.sendInvitation.mockRejectedValue(new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'Invitation emails are not configured on the server.'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Full name'), 'Bob');
    await user.type(screen.getByLabelText('Email'), 'bob@example.test');
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByText('Bob added, but the invitation was not sent: Invitation emails are not configured on the server.')).toBeTruthy();
    expect(within(card('Bob')).getByText('not invited yet')).toBeTruthy();
  });

  it('can create without inviting', async () => {
    await renderPage([row({ ...admin })]);
    usersApi.createUser.mockResolvedValue({ user: row({ id: 7, email: 'cy@example.test', fullName: 'Cy', hasPassword: false }) });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Full name'), 'Cy');
    await user.type(screen.getByLabelText('Email'), 'cy@example.test');
    await user.click(screen.getByLabelText('Email an invitation so they can choose a password'));
    await user.click(screen.getByRole('button', { name: 'Add user' }));
    await screen.findByText(/Cy added. Send an invitation/);
    expect(usersApi.sendInvitation).not.toHaveBeenCalled();
  });

  it('shows invitation status and resend/revoke controls only for accounts without a password', async () => {
    await renderPage([
      row({ ...admin }),
      row({ id: 2, email: 'p@example.test', fullName: 'Pending Pat', hasPassword: false, invitation: { id: 1, status: 'pending', expiresAt: '2026-11-01T00:00:00Z' } }),
      row({ id: 3, email: 'x@example.test', fullName: 'Expired Ed', hasPassword: false, invitation: { id: 2, status: 'expired' } }),
      row({ id: 4, email: 'a@example.test', fullName: 'Active Al', hasPassword: true }),
    ]);
    const pat = within(card('Pending Pat'));
    expect(pat.getByText('invitation sent')).toBeTruthy();
    expect(pat.getByRole('button', { name: 'Resend invitation' })).toBeTruthy();
    expect(pat.getByRole('button', { name: 'Revoke invitation' })).toBeTruthy();

    const ed = within(card('Expired Ed'));
    expect(ed.getByText('invitation expired')).toBeTruthy();
    expect(ed.queryByRole('button', { name: 'Revoke invitation' })).toBeNull();

    const al = within(card('Active Al'));
    expect(al.queryByRole('button', { name: /invitation/i })).toBeNull();
  });

  it('resends and revokes an invitation', async () => {
    await renderPage([
      row({ ...admin }),
      row({ id: 2, email: 'p@example.test', fullName: 'Pending Pat', hasPassword: false, invitation: { id: 1, status: 'pending' } }),
    ]);
    usersApi.sendInvitation.mockResolvedValue({ invitation: { id: 3, status: 'pending' } });
    usersApi.revokeInvitation.mockResolvedValue(null);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    await user.click(within(card('Pending Pat')).getByRole('button', { name: 'Resend invitation' }));
    expect(usersApi.sendInvitation).toHaveBeenCalledWith(2);
    expect(await screen.findByText('Invitation emailed to p@example.test.')).toBeTruthy();

    await user.click(within(card('Pending Pat')).getByRole('button', { name: 'Revoke invitation' }));
    expect(usersApi.revokeInvitation).toHaveBeenCalledWith(2);
    expect(await screen.findByText('invitation revoked')).toBeTruthy();
  });

  it('shows server errors for invitation actions', async () => {
    await renderPage([row({ ...admin }), row({ id: 2, email: 'p@example.test', fullName: 'Pending Pat', hasPassword: false })]);
    usersApi.sendInvitation.mockRejectedValue(new ApiError(502, 'EMAIL_SEND_FAILED', 'The mail server rejected the recipient address. The invitation was not sent; try again.'));
    const user = userEvent.setup();
    await user.click(within(card('Pending Pat')).getByRole('button', { name: 'Send invitation' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/mail server rejected/);
  });

  it('deactivating warns that sessions end and history is kept', async () => {
    await renderPage([row({ ...admin }), row({ id: 2, email: 'p@example.test', fullName: 'Leaving Lou' })]);
    usersApi.deactivateUser.mockResolvedValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await user.click(within(card('Leaving Lou')).getByRole('button', { name: 'Deactivate' }));
    expect(confirm.mock.calls[0][0]).toMatch(/signed out everywhere.*history is kept/);
    expect(usersApi.deactivateUser).toHaveBeenCalledWith(2);
    expect(await within(card('Leaving Lou')).findByText('inactive')).toBeTruthy();
  });
});
