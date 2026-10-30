import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { AcceptInvitationPage } from './AcceptInvitation.jsx';

vi.mock('../api/auth.js');

const TOKEN = 'tok_' + 'a'.repeat(40);

function LoginProbe() {
  const location = useLocation();
  return <p>login page {location.state?.activated ? 'activated' : ''} {location.state?.email}</p>;
}

function renderWithHash(hash) {
  window.history.replaceState(null, '', `/accept-invitation${hash}`);
  render(
    <MemoryRouter initialEntries={['/accept-invitation']}>
      <Routes>
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('AcceptInvitationPage', () => {
  it('reads the token from the URL fragment, removes it from the address bar and shows who it is for', async () => {
    authApi.verifyInvitation.mockResolvedValue({ invitation: { email: 'ivy@example.test', fullName: 'Ivy Invitee', expiresAt: '2026-11-01T00:00:00Z' } });
    renderWithHash(`#token=${TOKEN}`);
    expect(await screen.findByText('Ivy Invitee')).toBeTruthy();
    expect(authApi.verifyInvitation).toHaveBeenCalledWith(TOKEN);
    expect(window.location.hash).toBe('');
  });

  it('sets the password and sends the person to sign in', async () => {
    authApi.verifyInvitation.mockResolvedValue({ invitation: { email: 'ivy@example.test', fullName: 'Ivy', expiresAt: null } });
    authApi.acceptInvitation.mockResolvedValue(null);
    renderWithHash(`#token=${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'a-long-enough-password');
    await user.type(screen.getByLabelText('Confirm password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(authApi.acceptInvitation).toHaveBeenCalledWith(TOKEN, 'a-long-enough-password');
    expect(await screen.findByText(/login page activated ivy@example.test/)).toBeTruthy();
  });

  it('validates the password before calling the API', async () => {
    authApi.verifyInvitation.mockResolvedValue({ invitation: { email: 'ivy@example.test', fullName: 'Ivy', expiresAt: null } });
    renderWithHash(`#token=${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(screen.getByText('Use at least 12 characters')).toBeTruthy();
    expect(screen.getByText('The passwords do not match')).toBeTruthy();
    expect(authApi.acceptInvitation).not.toHaveBeenCalled();
  });

  it('explains an expired invitation', async () => {
    authApi.verifyInvitation.mockRejectedValue(new ApiError(410, 'INVITATION_EXPIRED', 'expired'));
    renderWithHash(`#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toMatch('This invitation has expired. Ask your administrator to send a new one.');
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('explains an invalid or used invitation', async () => {
    authApi.verifyInvitation.mockRejectedValue(new ApiError(400, 'INVALID_INVITATION', 'invalid'));
    renderWithHash(`#token=${TOKEN}`);
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid or has already been used/);
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeTruthy();
  });

  it('treats a link without a token as invalid without calling the API', async () => {
    renderWithHash('');
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid or has already been used/);
    expect(authApi.verifyInvitation).not.toHaveBeenCalled();
  });

  it('shows an invitation that expired while the form was open', async () => {
    authApi.verifyInvitation.mockResolvedValue({ invitation: { email: 'ivy@example.test', fullName: 'Ivy', expiresAt: null } });
    authApi.acceptInvitation.mockRejectedValue(new ApiError(410, 'INVITATION_EXPIRED', 'expired'));
    renderWithHash(`#token=${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'a-long-enough-password');
    await user.type(screen.getByLabelText('Confirm password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/has expired/);
  });
});
