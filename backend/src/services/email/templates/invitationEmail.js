// Employee invitation email (Phase 2). Contains the one-time activation link and nothing else
// sensitive: no password is ever emailed. The token is in the URL fragment (#token=...), which
// browsers never send to a server, so it can't end up in proxy or API request logs.

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export const invitationLink = (appUrl, token) => `${appUrl}/accept-invitation#token=${encodeURIComponent(token)}`;

function formatExpiry(date) {
  return new Date(date).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/**
 * @param recipient { fullName }
 * @param inviter   { fullName } or null
 * @param link      full activation link (from invitationLink)
 * @param expiresAt Date
 */
export function renderInvitationEmail({ recipient, inviter, link, expiresAt, appName = 'WorkAgent' }) {
  const firstName = oneLine(recipient.fullName).split(' ')[0] || 'there';
  const by = inviter?.fullName ? ` by ${oneLine(inviter.fullName)}` : '';
  const expiry = formatExpiry(expiresAt);
  const subject = oneLine(`You're invited to ${appName}`).slice(0, 255);

  const text = [
    `Hi ${firstName},`,
    '',
    `You have been invited${by} to ${appName}. Open the link below to choose your password and activate your account:`,
    '',
    link,
    '',
    `The link works once and expires on ${expiry}. If it has expired, ask your administrator to send a new invitation.`,
    '',
    'If you were not expecting this email, you can ignore it.',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #0f172a; line-height: 1.5;">
  <p>Hi ${escapeHtml(firstName)},</p>
  <p>You have been invited${escapeHtml(by)} to ${escapeHtml(appName)}. Choose your password to activate your account:</p>
  <p><a href="${escapeHtml(link)}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Activate your account</a></p>
  <p style="color: #475569; font-size: 14px;">The link works once and expires on ${escapeHtml(expiry)}. If it has expired, ask your administrator to send a new invitation.</p>
  <p style="color: #475569; font-size: 14px;">If you were not expecting this email, you can ignore it.</p>
</body></html>`;

  return { subject, text, html };
}
