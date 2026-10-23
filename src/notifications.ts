import type { DisplaySessionNotice } from './access';

/** Minimal structural shape for the Cloudflare send_email binding. */
export interface EmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export interface NotificationConfig {
  email?: EmailBinding;
  ownerEmail: string;
  fromEmail: string;
  adminUrl: string;
}

const SEND_TIMEOUT_MS = 5000;
const EMAIL_PATTERN = /^[^\s@<>]{1,254}@[^\s@<>]{1,253}$/;
const DISPLAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanLabel(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80);
  return cleaned || null;
}

function validAdminUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('notification_timeout')), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Plain-text body only. It intentionally excludes IP addresses, ZIP codes, raw
 * User-Agent strings, cookies, pairing codes and any display content.
 */
export function notificationText(notice: DisplaySessionNotice, adminUrl: string): string {
  const browser = cleanLabel(notice.browser);
  const os = cleanLabel(notice.os);
  const device = [browser, os].filter((value): value is string => value !== null).join(' on ');
  const lines = [
    'A display paired with Sabio and received a session.',
    '',
    `Time: ${new Date(notice.at * 1000).toISOString()}`,
    `Display: ${notice.displayId}`,
  ];
  if (device) lines.push(`Approximate device: ${device}`);
  lines.push('');
  lines.push(validAdminUrl(adminUrl)
    ? `If this was unexpected, revoke the display at ${adminUrl}`
    : 'If this was unexpected, revoke the display from the admin page.');
  return `${lines.join('\n')}\n`;
}

/** Best-effort owner alert. Failures never block or roll back session issuance. */
export async function notifyNewDisplay(
  config: NotificationConfig,
  notice: DisplaySessionNotice,
): Promise<boolean> {
  if (!config.email || typeof config.email.send !== 'function') return false;
  if (!EMAIL_PATTERN.test(config.ownerEmail) || !EMAIL_PATTERN.test(config.fromEmail)) return false;
  if (!DISPLAY_ID_PATTERN.test(notice.displayId) || !Number.isSafeInteger(notice.at)) return false;

  try {
    await withTimeout(config.email.send({
      to: config.ownerEmail,
      from: config.fromEmail,
      subject: 'Sabio: new display paired',
      text: notificationText(notice, config.adminUrl),
    }), SEND_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}
