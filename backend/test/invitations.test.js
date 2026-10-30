// Phase 2: employee invitations and password setup. No real email is sent: the provider is
// replaced by an in-memory fake, which is also how the test reads the link from the "email".
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { sha256 } from '../src/services/authService.js';
import { email } from '../src/services/email/index.js';
import { EmailSendError } from '../src/services/email/errors.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const NEW_PASSWORD = 'a-brand-new-passphrase';

let sent;
let failNext = false;
const fakeProvider = {
  name: 'fake',
  async send(message) {
    if (failNext) {
      failNext = false;
      throw new EmailSendError('SMTP 550: mailbox unavailable', { retryable: false, publicMessage: 'The mail server rejected the recipient address' });
    }
    sent.push(message);
    return { messageId: `fake-${sent.length}` };
  },
};

let admin;
let employee;
let adminId;

const tokenFrom = (message) => decodeURIComponent(message.text.match(/#token=([^\s]+)/)[1]);
const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
  delete: (url) => request(app).delete(url).set('Cookie', cookie),
});
const verify = (token) => request(app).post('/api/v1/auth/invitations/verify').send({ token });
const accept = (token, password = NEW_PASSWORD) => request(app).post('/api/v1/auth/invitations/accept').send({ token, password });

async function newInvitee(address, fullName = 'New Person') {
  const res = await as(admin).post('/api/v1/users', { email: address, fullName, role: 'employee' });
  assert.equal(res.status, 201);
  return res.body.user.id;
}

async function invite(userId) {
  const res = await as(admin).post(`/api/v1/users/${userId}/invitations`);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { invitation: res.body.invitation, token: tokenFrom(sent.at(-1)) };
}

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin', fullName: 'Ada Admin' });
  await createUser({ email: 'emp@example.test', role: 'employee' });
  admin = await loginCookie(app, 'admin@example.test');
  employee = await loginCookie(app, 'emp@example.test');
  email.isConfigured = () => true;
  email.configurationProblem = () => null;
  email.getProvider = () => fakeProvider;
  email.from = () => 'WorkAgent <no-reply@example.test>';
  config.email.appPublicUrl = 'http://app.example.test';
});
beforeEach(() => {
  sent = [];
  failNext = false;
});
after(closeDatabase);

describe('sending invitations', () => {
  it('emails a one-time link and stores only the token hash', async () => {
    const userId = await newInvitee('ivy@example.test', 'Ivy Invitee');
    const { invitation, token } = await invite(userId);

    assert.equal(invitation.status, 'pending');
    assert.equal(invitation.email, 'ivy@example.test');
    assert.ok(invitation.sentAt);
    assert.equal(invitation.token, undefined, 'the API never returns the token');
    assert.equal(invitation.tokenHash, undefined);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ivy@example.test');
    assert.match(sent[0].text, /http:\/\/app\.example\.test\/accept-invitation#token=/);
    assert.ok(token.length >= 40, '256-bit random token');
    assert.doesNotMatch(sent[0].text + sent[0].html, /password:/i, 'no password in the email');

    const [[row]] = await pool.query('SELECT token_hash, expires_at, created_at FROM user_invitations WHERE id = ?', [invitation.id]);
    assert.equal(row.token_hash, sha256(token));
    const hours = (new Date(row.expires_at) - new Date(row.created_at)) / 3_600_000;
    assert.equal(Math.round(hours), config.invitations.ttlHours);

    // The token appears nowhere in the audit log.
    const [audits] = await pool.query('SELECT after_json FROM audit_logs WHERE entity_type = ? AND entity_id = ?', ['user', userId]);
    assert.ok(audits.length >= 1);
    assert.ok(audits.every((a) => !JSON.stringify(a.after_json ?? '').includes(token)));
  });

  it('shows the invitation status in the user list', async () => {
    const res = await as(admin).get('/api/v1/users');
    const ivy = res.body.users.find((u) => u.email === 'ivy@example.test');
    assert.equal(ivy.invitation.status, 'pending');
    assert.equal(ivy.hasPassword, false);
    const plain = res.body.users.find((u) => u.email === 'emp@example.test');
    assert.equal(plain.invitation, null);
  });

  it('resending revokes the previous link', async () => {
    const userId = await newInvitee('resend@example.test');
    const first = await invite(userId);
    const second = await invite(userId);
    assert.notEqual(first.token, second.token);
    assert.equal((await verify(first.token)).status, 400);
    assert.equal((await verify(second.token)).status, 200);
    const list = await as(admin).get(`/api/v1/users/${userId}/invitations`);
    assert.deepEqual(list.body.invitations.map((i) => i.status), ['pending', 'revoked']);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.invitation_resent' AND entity_id = ?", [userId]);
    assert.equal(n, 1);
  });

  it('refuses users who already have a password, inactive users and unknown users', async () => {
    const [[emp]] = await pool.query("SELECT id FROM users WHERE email = 'emp@example.test'");
    assert.equal((await as(admin).post(`/api/v1/users/${emp.id}/invitations`)).status, 409);
    const inactive = await newInvitee('gone@example.test');
    await as(admin).delete(`/api/v1/users/${inactive}`);
    assert.equal((await as(admin).post(`/api/v1/users/${inactive}/invitations`)).status, 409);
    assert.equal((await as(admin).post('/api/v1/users/999999/invitations')).status, 404);
    assert.equal(sent.length, 0);
  });

  it('only admins can send, list or revoke invitations', async () => {
    const userId = await newInvitee('guarded@example.test');
    for (const res of [
      await as(employee).post(`/api/v1/users/${userId}/invitations`),
      await as(employee).get(`/api/v1/users/${userId}/invitations`),
      await as(employee).post(`/api/v1/users/${userId}/invitations/revoke`),
    ]) {
      assert.equal(res.status, 403);
    }
    assert.equal((await request(app).post(`/api/v1/users/${userId}/invitations`)).status, 401);
    assert.equal(sent.length, 0);
  });

  it('when email is not configured: 503, nothing created, no token exposed', async () => {
    const userId = await newInvitee('noemail@example.test');
    const saved = email.isConfigured;
    email.isConfigured = () => false;
    email.configurationProblem = () => 'EMAIL_PROVIDER is not set';
    try {
      const res = await as(admin).post(`/api/v1/users/${userId}/invitations`);
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'EMAIL_NOT_CONFIGURED');
      assert.equal(JSON.stringify(res.body).includes('token'), false);
    } finally {
      email.isConfigured = saved;
      email.configurationProblem = () => null;
    }
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM user_invitations WHERE user_id = ?', [userId]);
    assert.equal(n, 0);
  });

  it('when sending fails: 502 and the link is unusable (status failed)', async () => {
    const userId = await newInvitee('bounce@example.test');
    failNext = true;
    const res = await as(admin).post(`/api/v1/users/${userId}/invitations`);
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'EMAIL_SEND_FAILED');
    const list = await as(admin).get(`/api/v1/users/${userId}/invitations`);
    assert.equal(list.body.invitations[0].status, 'failed');
  });
});

describe('accepting invitations', () => {
  it('verify shows who it is for; accept sets the password; the person can sign in', async () => {
    const userId = await newInvitee('anna@example.test', 'Anna Activate');
    const { token } = await invite(userId);

    const v = await verify(token);
    assert.equal(v.status, 200);
    assert.deepEqual(Object.keys(v.body.invitation).sort(), ['email', 'expiresAt', 'fullName']);
    assert.equal(v.body.invitation.fullName, 'Anna Activate');

    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: 'anna@example.test', password: NEW_PASSWORD })).status, 401);
    const res = await accept(token);
    assert.equal(res.status, 204);

    const login = await request(app).post('/api/v1/auth/login').send({ email: 'anna@example.test', password: NEW_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.email, 'anna@example.test');

    const list = await as(admin).get(`/api/v1/users/${userId}/invitations`);
    assert.equal(list.body.invitations[0].status, 'accepted');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.activated' AND entity_id = ?", [userId]);
    assert.equal(n, 1);
  });

  it('is single use: the same link cannot be used again', async () => {
    const userId = await newInvitee('once@example.test');
    const { token } = await invite(userId);
    assert.equal((await accept(token)).status, 204);
    const again = await accept(token, 'another-long-password');
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'INVALID_INVITATION');
    // The first password still works; the second attempt changed nothing.
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: 'once@example.test', password: NEW_PASSWORD })).status, 200);
  });

  it('expired links are refused with a distinct, non-sensitive error', async () => {
    const userId = await newInvitee('late@example.test');
    const { invitation, token } = await invite(userId);
    await pool.query('UPDATE user_invitations SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [invitation.id]);
    const v = await verify(token);
    assert.equal(v.status, 410);
    assert.equal(v.body.error.code, 'INVITATION_EXPIRED');
    assert.equal((await accept(token)).status, 410);
    const list = await as(admin).get(`/api/v1/users/${userId}/invitations`);
    assert.equal(list.body.invitations[0].status, 'expired');
  });

  it('revoked links are refused', async () => {
    const userId = await newInvitee('revoked@example.test');
    const { token } = await invite(userId);
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/invitations/revoke`)).status, 204);
    assert.equal((await verify(token)).status, 400);
    assert.equal((await as(admin).post(`/api/v1/users/${userId}/invitations/revoke`)).status, 404, 'nothing left to revoke');
  });

  it('a deactivated user cannot activate, even with a link sent before deactivation', async () => {
    const userId = await newInvitee('deact@example.test');
    const { token } = await invite(userId);
    await as(admin).delete(`/api/v1/users/${userId}`);
    assert.equal((await verify(token)).status, 400);
  });

  it('a link stops working if the user’s email address changed after it was sent', async () => {
    const userId = await newInvitee('old-address@example.test');
    const { token } = await invite(userId);
    await as(admin).patch(`/api/v1/users/${userId}`, { email: 'new-address@example.test' });
    const v = await verify(token);
    assert.equal(v.status, 400);
    assert.equal(v.body.error.code, 'INVALID_INVITATION');
  });

  it('unknown and malformed tokens get the same generic error', async () => {
    for (const res of [await verify('x'.repeat(43)), await verify('short')]) {
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_INVITATION');
      assert.equal(res.body.error.message, 'This invitation link is invalid or has already been used.');
    }
  });

  it('validates the new password (length, bcrypt 72-byte limit) without consuming the link', async () => {
    const userId = await newInvitee('weak@example.test');
    const { token } = await invite(userId);
    const short = await accept(token, 'short');
    assert.equal(short.status, 400);
    assert.equal(short.body.error.details[0].field, 'password');
    assert.equal((await accept(token, 'é'.repeat(40))).status, 400, '80 bytes');
    assert.equal((await verify(token)).status, 200, 'still usable');
  });

  it('rate-limits activation attempts per IP', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await accept('y'.repeat(43));
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
  });
});
