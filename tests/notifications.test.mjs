import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/notifications.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const notifications = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

const notice = {
  displayId: '00000000-0000-4000-8000-000000000001',
  at: Math.floor(Date.parse('2026-10-22T12:00:00Z') / 1000),
  browser: 'Firefox 68.0',
  os: 'Android 9',
  location: 'Portland, Oregon, US',
};

function config(overrides = {}) {
  return {
    email: { async send() { return { messageId: 'synthetic' }; } },
    ownerEmail: 'owner@example.com',
    fromEmail: 'notify@example.com',
    adminUrl: 'https://example.com/admin',
    ...overrides,
  };
}

test('notification text carries only the event, a coarse device label and a revocation link', () => {
  const text = notifications.notificationText(notice, 'https://example.com/admin');
  assert.match(text, /\[Login\] Authentication Request/);
  assert.match(text, /A display authenticated with Sabio/);
  assert.match(text, /Time: 2026-10-22T12:00:00\.000Z/);
  assert.match(text, /Display: 00000000-0000-4000-8000-000000000001/);
  assert.match(text, /Device: Firefox 68\.0 on Android 9/);
  assert.match(text, /Approximate network location: Portland, Oregon, US/);
  assert.match(text, /Dashboard: https:\/\/example\.com\/admin/);
  assert.equal(text.includes('127.0.0.1'), false);
  assert.equal(text.includes('zip'), false);
  assert.equal(text.includes('cookie'), false);
});

test('device labels are stripped of control characters and markup, and unsafe admin links fall back to text', () => {
  const text = notifications.notificationText({
    ...notice,
    browser: '<script>\u0000Chrome',
    os: null,
  }, 'javascript:alert(1)');
  assert.equal(text.includes('<script>'), false);
  assert.equal(text.includes('\u0000'), false);
  assert.match(text, /Device: scriptChrome/);
  assert.match(text, /revoke the display from the admin page/);
  assert.equal(text.includes('Dashboard:'), false);
  assert.equal(text.includes('javascript:'), false);
});

test('a configured binding sends one plain-text message to the owner', async () => {
  const sent = [];
  const email = { async send(message) { sent.push(message); return { messageId: 'synthetic' }; } };
  assert.equal(await notifications.notifyNewDisplay(config({ email }), notice), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.deepEqual(sent[0].from, { email: 'notify@example.com', name: 'Sabio' });
  assert.equal(sent[0].subject, '[Login] Sabio authentication request');
  assert.match(sent[0].text, /Display: 00000000-0000-4000-8000-000000000001/);
  assert.equal(Object.hasOwn(sent[0], 'html'), false);
});

test('missing, invalid or failing email configuration is a quiet no-op', async () => {
  let sends = 0;
  const email = { async send() { sends += 1; throw new Error('synthetic delivery failure'); } };
  assert.equal(await notifications.notifyNewDisplay(config({ email: undefined }), notice), false);
  assert.equal(await notifications.notifyNewDisplay(config({ email, ownerEmail: 'not-an-email' }), notice), false);
  assert.equal(await notifications.notifyNewDisplay(config({ email, fromEmail: '' }), notice), false);
  assert.equal(await notifications.notifyNewDisplay(config({ email }), { ...notice, displayId: '../../etc/passwd' }), false);
  assert.equal(sends, 0);
  assert.equal(await notifications.notifyNewDisplay(config({ email }), notice), false);
  assert.equal(sends, 1, 'delivery failures are reported, not retried');
});
