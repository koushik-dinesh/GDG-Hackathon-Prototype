import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/me.js';
import { ApiError } from '../api/client.js';
import { ProfilePage, passwordProblems } from './Profile.jsx';

vi.mock('../api/me.js');
const auth = vi.hoisted(() => ({ updateUser: vi.fn() }));
vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const GOOD = 'a-long-enough-password';
const kinds = [
  { kind: 'task_assigned', label: 'A task is assigned to me' },
  { kind: 'daily_digest', label: 'A daily summary' },
];
const profile = { id: 1, email: 'ana@example.test', fullName: 'Ana Garcia', role: 'employee', preferences: { notifications: { task_assigned: true, daily_digest: false, jobs_dead: true }, timeZone: null } };

const card = async (title) => within((await screen.findByRole('heading', { name: title })).closest('section'));

beforeEach(() => {
  api.getProfile.mockResolvedValue({ profile, notificationKinds: kinds });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('details', () => {
  it('shows email and role read-only, and saves the name', async () => {
    api.updateProfile.mockResolvedValue({ user: { ...profile, fullName: 'Ana G' } });
    render(<ProfilePage />);
    const c = await card('Your details');
    expect(c.getByLabelText('Email').disabled).toBe(true);
    expect(c.getByLabelText('Role').disabled).toBe(true);
    expect(c.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    await userEvent.clear(c.getByLabelText('Full name'));
    await userEvent.type(c.getByLabelText('Full name'), 'Ana G');
    await userEvent.click(c.getByRole('button', { name: 'Save' }));
    expect(api.updateProfile).toHaveBeenCalledWith({ fullName: 'Ana G' });
    expect((await c.findByRole('status')).textContent).toContain('Your name was saved.');
    expect(auth.updateUser).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Ana G' }));
  });
});

describe('password', () => {
  const fill = async (c, current, next, again = next) => {
    if (current) await userEvent.type(c.getByLabelText('Current password'), current);
    if (next) await userEvent.type(c.getByLabelText('New password'), next);
    if (again) await userEvent.type(c.getByLabelText('Repeat new password'), again);
    await userEvent.click(c.getByRole('button', { name: 'Change password' }));
  };

  it('checks the rules before sending', () => {
    expect(passwordProblems({ currentPassword: '', newPassword: 'short', confirm: 'other' })).toEqual({
      currentPassword: 'Required',
      newPassword: 'Use at least 12 characters',
      confirm: 'The two passwords don’t match',
    });
    expect(passwordProblems({ currentPassword: 'x', newPassword: 'é'.repeat(40), confirm: 'é'.repeat(40) }).newPassword).toMatch(/72 bytes/);
    expect(passwordProblems({ currentPassword: 'x', newPassword: ' '.repeat(12), confirm: ' '.repeat(12) }).newPassword).toMatch(/only spaces/);
    expect(passwordProblems({ currentPassword: GOOD, newPassword: GOOD, confirm: GOOD }).newPassword).toMatch(/differ/);
    expect(passwordProblems({ currentPassword: 'x', newPassword: GOOD, confirm: GOOD })).toEqual({});
  });

  it('sends nothing when the form has problems', async () => {
    render(<ProfilePage />);
    await fill(await card('Change password'), 'current', GOOD, 'different-password');
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(await screen.findByText('The two passwords don’t match')).toBeTruthy();
  });

  it('says how many sessions ended and empties the form', async () => {
    api.changePassword.mockResolvedValue({ changed: true, otherSessionsSignedOut: 2 });
    render(<ProfilePage />);
    const c = await card('Change password');
    await fill(c, 'current', GOOD);
    expect(api.changePassword).toHaveBeenCalledWith('current', GOOD);
    expect((await c.findByRole('status')).textContent).toContain('Password changed. Signed out of 2 other sessions.');
    expect(c.getByLabelText('New password').value).toBe('');
  });

  it('shows a wrong current password next to the field', async () => {
    api.changePassword.mockRejectedValue(new ApiError(400, 'INVALID_PASSWORD', 'The current password is not correct', [{ field: 'currentPassword', message: 'Not correct' }]));
    render(<ProfilePage />);
    const c = await card('Change password');
    await fill(c, 'wrong', GOOD);
    expect(await c.findByText('Not correct')).toBeTruthy();
    expect(c.queryByRole('alert')).toBeNull();
  });

  it('shows other failures', async () => {
    api.changePassword.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests, try again later'));
    render(<ProfilePage />);
    const c = await card('Change password');
    await fill(c, 'current', GOOD);
    expect((await c.findByRole('alert')).textContent).toContain('Too many requests');
  });
});

describe('preferences', () => {
  it('shows only the kinds of this role with their saved state, and saves them with the time zone', async () => {
    api.updatePreferences.mockResolvedValue({ preferences: { notifications: { task_assigned: false, daily_digest: false }, timeZone: 'Asia/Kolkata' } });
    render(<ProfilePage />);
    const c = await card('Notification preferences');
    expect(c.getAllByRole('checkbox')).toHaveLength(2);
    expect(c.getByRole('checkbox', { name: 'A task is assigned to me' }).checked).toBe(true);
    expect(c.getByRole('checkbox', { name: 'A daily summary' }).checked).toBe(false);
    await userEvent.click(c.getByRole('checkbox', { name: 'A task is assigned to me' }));
    await userEvent.selectOptions(c.getByLabelText('Time zone'), 'Asia/Kolkata');
    await userEvent.click(c.getByRole('button', { name: 'Save preferences' }));
    expect(api.updatePreferences).toHaveBeenCalledWith({ notifications: { task_assigned: false, daily_digest: false }, timeZone: 'Asia/Kolkata' });
    expect((await c.findByRole('status')).textContent).toContain('Your preferences were saved.');
  });

  it('clears the time zone with Company default, and shows failures', async () => {
    api.getProfile.mockResolvedValue({ profile: { ...profile, preferences: { ...profile.preferences, timeZone: 'Asia/Kolkata' } }, notificationKinds: kinds });
    api.updatePreferences.mockRejectedValue(new Error('Server down'));
    render(<ProfilePage />);
    const c = await card('Notification preferences');
    expect(c.getByLabelText('Time zone').value).toBe('Asia/Kolkata');
    await userEvent.selectOptions(c.getByLabelText('Time zone'), '');
    await userEvent.click(c.getByRole('button', { name: 'Save preferences' }));
    expect(api.updatePreferences).toHaveBeenCalledWith(expect.objectContaining({ timeZone: null }));
    expect((await c.findByRole('alert')).textContent).toContain('Server down');
  });
});

it('shows a load failure', async () => {
  api.getProfile.mockRejectedValue(new Error('Server down'));
  render(<ProfilePage />);
  expect((await screen.findByRole('alert')).textContent).toContain('Server down');
});
