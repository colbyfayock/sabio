import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { build } from 'esbuild';
import { LocalD1 } from './helpers/local-d1.mjs';

const ORIGIN = 'https://example.com';
const result = await build({
  entryPoints: ['src/access.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const access = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

beforeEach((context) => {
  context.mock.method(Date, 'now', () => Date.parse('2026-10-21T12:00:00Z'));
});

function makeRequest(path, options = {}) {
  const headers = new Headers({
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
    ...options.headers,
  });
  return new Request(`${options.host ?? ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
}

function post(path, body = '{}', headers = {}) {
  return makeRequest(path, { method: 'POST', body, headers });
}

async function call(db, request, verifyAdmin = async () => true, origin = ORIGIN) {
  return access.handleAccessRequest(request, db, verifyAdmin, origin);
}

async function enroll(db) {
  const response = await call(db, post('/api/enrollment'));
  assert.equal(response.status, 201);
  const data = await response.json();
  const pendingCookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-sabio_pending='));
  assert.ok(pendingCookie);
  return {
    code: data.code,
    expiresAt: data.expiresAt,
    cookie: pendingCookie.split(';', 1)[0],
  };
}

async function approve(db, code, verifyAdmin = async () => true) {
  return call(db, post('/api/admin/approve', JSON.stringify({ code })), verifyAdmin);
}

async function finish(db, pendingCookie) {
  return call(db, post('/api/enrollment/complete', '{}', { Cookie: pendingCookie }));
}

test('unrelated routes return null; matching hosts, paths, methods, queries, and CSRF are bounded', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  assert.equal(await call(db, makeRequest('/not-an-access-route')), null);
  for (const path of ['/api/enrollment', '/api/enrollment/anything', '/api/admin/unknown', '/api/display/anything']) {
    const wrongHost = makeRequest(path, { host: 'https://other.example.com' });
    assert.equal((await call(db, wrongHost)).status, 403);
  }
  for (const path of ['/api/enrollment/anything', '/api/admin/unknown', '/api/display/anything']) {
    assert.equal((await call(db, makeRequest(path))).status, 404);
  }
  assert.equal((await call(db, makeRequest('/api/enrollment'))).status, 405);
  assert.equal((await call(db, post('/api/enrollment?code=secret'))).status, 400);
  assert.equal((await call(db, post('/api/enrollment', '{}', { Origin: 'https://other.example.com' }))).status, 403);
  assert.equal((await call(db, post('/api/enrollment', '{"unexpected":true}'))).status, 400);
  assert.equal((await call(db, post('/api/enrollment', '{}', { 'Content-Type': 'text/plain' }))).status, 400);
  assert.equal((await call(db, post('/api/enrollment', JSON.stringify({ value: 'x'.repeat(600) })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment', '{}', { 'CF-Connecting-IP': '' }))).status, 403);
  assert.equal((await call(db, post('/api/enrollment'), async () => true, 'http://example.com')).status, 403);
});

test('enrollment uses an independent pending credential and cannot be claimed by its code', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  const enrollment = await enroll(db);
  assert.match(enrollment.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  assert.ok(enrollment.expiresAt > Math.floor(Date.now() / 1000));
  const pendingPoll = await finish(db, enrollment.cookie);
  assert.equal(pendingPoll.status, 202);
  assert.deepEqual(await pendingPoll.json(), { status: 'pending' });
  assert.equal((await finish(db, `${enrollment.cookie}; ${enrollment.cookie}`)).status, 401);

  assert.equal((await approve(db, enrollment.code)).status, 200);
  const forgedCredential = `__Host-sabio_pending=${enrollment.code.padEnd(64, 'A')}`;
  assert.equal((await finish(db, forgedCredential)).status, 401);

  const completed = await finish(db, enrollment.cookie);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { status: 'approved' });
  const cookies = completed.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  const sessionCookie = cookies.find((value) => value.startsWith('__Host-sabio_display='));
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /; Secure; HttpOnly; SameSite=Strict/);
  assert.match(sessionCookie, /; Path=\//);
  assert.ok(cookies.some((value) => value.startsWith('__Host-sabio_pending=; Max-Age=0')));

  const replay = await finish(db, enrollment.cookie);
  assert.equal(replay.status, 401);
  assert.equal((await approve(db, enrollment.code)).status, 404);
});

test('admin authentication fails closed and is rate-limited by hashed client IP before verification', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  let verified = 0;
  const deny = async () => {
    verified += 1;
    return false;
  };

  assert.equal((await call(db, makeRequest('/api/admin/displays', { headers: { 'CF-Connecting-IP': '' } }), deny)).status, 403);
  assert.equal(verified, 0);
  assert.equal((await call(db, makeRequest('/api/admin/displays'), deny)).status, 401);
  assert.equal(verified, 1);

  const allow = async () => {
    verified += 1;
    return true;
  };
  let finalResponse;
  for (let attempt = 0; attempt < 29; attempt += 1) {
    finalResponse = await call(db, makeRequest('/api/admin/displays'), allow);
  }
  assert.equal(finalResponse.status, 200);
  const beforeLimit = verified;
  assert.equal((await call(db, makeRequest('/api/admin/displays'), allow)).status, 429);
  assert.equal(verified, beforeLimit);
  for (let attempt = 0; attempt < 200; attempt++) await call(db, makeRequest('/api/admin/displays'), allow);
  assert.equal(db.sqlite.prepare("SELECT count FROM access_rate_limits WHERE bucket_key = 'admin-verify-global'").get().count, 30);
});

test('admin can list, approve once, and revoke a display session', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const enrollment = await enroll(db);
  assert.equal((await approve(db, enrollment.code, async () => false)).status, 401);
  assert.equal((await approve(db, enrollment.code)).status, 200);
  const listing = await call(db, makeRequest('/api/admin/displays'));
  assert.equal(listing.status, 200);
  const displays = (await listing.json()).displays;
  assert.equal(displays.length, 1);
  assert.equal(displays[0].revoked, false);
  assert.equal(displays[0].revokedAt, null);
  assert.deepEqual(displays[0].device, { type: 'unknown', browser: null, os: null });
  assert.equal(displays[0].lastSeenAt, null);
  assert.equal(displays[0].weatherArea, null);
  assert.equal(typeof displays[0].createdAt, 'number');
  assert.equal(typeof displays[0].expiresAt, 'number');

  const completed = await finish(db, enrollment.cookie);
  const sessionCookie = completed.headers.getSetCookie()
    .find((value) => value.startsWith('__Host-sabio_display=')).split(';', 1)[0];
  const displayRequest = makeRequest('/api/display', { headers: { Cookie: sessionCookie } });
  const authorized = await call(db, displayRequest);
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { displayId: displays[0].id, expiresAt: displays[0].expiresAt });
  assert.ok(await access.getDisplaySession(displayRequest, db));
  const duplicateCookieRequest = makeRequest('/api/display', { headers: { Cookie: `${sessionCookie}; ${sessionCookie}` } });
  assert.equal((await call(db, duplicateCookieRequest)).status, 401);

  const revoked = await call(db, post('/api/admin/revoke', JSON.stringify({ id: displays[0].id })));
  assert.equal(revoked.status, 204);
  assert.equal((await call(db, displayRequest)).status, 401);
  assert.equal((await call(db, makeRequest('/api/admin/displays'))).status, 200);
  assert.equal((await (await call(db, makeRequest('/api/admin/displays'))).json()).displays[0].revoked, true);
  assert.equal(typeof (await (await call(db, makeRequest('/api/admin/displays'))).json()).displays[0].revokedAt, 'number');
});

test('owner may set and clear an optional display nickname without admitting markup or another display', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const first = await enroll(db);
  const second = await enroll(db);
  assert.equal((await approve(db, first.code)).status, 200);
  assert.equal((await approve(db, second.code)).status, 200);
  const listed = await (await call(db, makeRequest('/api/admin/displays'))).json();
  const [display1, display2] = listed.displays;
  const rename = (body, admin = async () => true) => call(db,
    post('/api/admin/label', JSON.stringify(body)), admin);
  assert.equal((await rename({ id: display1.id, name: 'Living room frame' })).status, 200);
  let refreshed = await (await call(db, makeRequest('/api/admin/displays'))).json();
  assert.equal(refreshed.displays.find((display) => display.id === display1.id).name, 'Living room frame');
  assert.equal(refreshed.displays.find((display) => display.id === display2.id).name, null);
  assert.equal((await rename({ id: display1.id, name: '<img src=x>' })).status, 400);
  assert.equal((await rename({ id: display1.id, name: '   ' })).status, 200);
  assert.equal((await rename({ id: display1.id, name: 'Owner tries to rename', extra: 'ignored?' })).status, 400);
  assert.equal((await rename({ id: display2.id, name: 'Blocked' }, async () => false)).status, 401);
  refreshed = await (await call(db, makeRequest('/api/admin/displays'))).json();
  assert.equal(refreshed.displays.find((display) => display.id === display1.id).name, null);
  assert.equal(refreshed.displays.find((display) => display.id === display2.id).name, null);
});

test('approval and display-session expiry deny access', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const expired = await enroll(db);
  db.sqlite.prepare('UPDATE access_enrollments SET expires_at = ? WHERE status = ?')
    .run(Math.floor(Date.now() / 1000) - 1, 'pending');
  assert.equal((await approve(db, expired.code)).status, 404);
  assert.equal((await finish(db, expired.cookie)).status, 401);

  const current = await enroll(db);
  assert.equal((await approve(db, current.code)).status, 200);
  const completed = await finish(db, current.cookie);
  const cookie = completed.headers.getSetCookie()
    .find((value) => value.startsWith('__Host-sabio_display=')).split(';', 1)[0];
  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await call(db, makeRequest('/api/display', { headers: { Cookie: cookie } }))).status, 401);
});

test('display scope comes only from the session, and revoking one browser does not revoke another', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const credentials = [];
  for (let index = 0; index < 2; index++) {
    const enrollment = await enroll(db);
    assert.equal((await approve(db, enrollment.code)).status, 200);
    const completed = await finish(db, enrollment.cookie);
    const cookie = completed.headers.getSetCookie().find((value) => value.startsWith('__Host-sabio_display=')).split(';')[0];
    const data = await (await call(db, makeRequest('/api/display', { headers: { Cookie: cookie } }))).json();
    credentials.push({ cookie, id: data.displayId });
  }
  assert.notEqual(credentials[0].id, credentials[1].id);
  const forgedScope = makeRequest('/api/display', { headers: { Cookie: credentials[0].cookie, 'X-Display-ID': credentials[1].id } });
  assert.equal((await (await call(db, forgedScope)).json()).displayId, credentials[0].id);
  assert.equal((await call(db, makeRequest('/api/display/' + credentials[1].id, { headers: { Cookie: credentials[0].cookie } }))).status, 404);
  assert.equal((await call(db, post('/api/admin/revoke', JSON.stringify({ id: credentials[0].id })))).status, 204);
  assert.equal((await call(db, makeRequest('/api/display', { headers: { Cookie: credentials[0].cookie } }))).status, 401);
  assert.equal((await call(db, makeRequest('/api/display', { headers: { Cookie: credentials[1].cookie } }))).status, 200);
});

test('concurrent completion gives exactly one request a session', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const enrollment = await enroll(db);
  assert.equal((await approve(db, enrollment.code)).status, 200);

  const responses = await Promise.all([finish(db, enrollment.cookie), finish(db, enrollment.cookie)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  const winners = responses.filter((response) => response.status === 200);
  assert.equal(winners[0].headers.getSetCookie().filter((value) => value.startsWith('__Host-sabio_display=')).length, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_display_sessions').get().count, 1);
});

test('enrollment and weather rate limits are enforced per IP and display', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await call(db, post('/api/enrollment'))).status, 201);
  assert.equal((await call(db, post('/api/enrollment'))).status, 429);
  for (let attempt = 0; attempt < 50; attempt++) await call(db, post('/api/enrollment'));
  assert.equal(db.sqlite.prepare("SELECT count FROM access_rate_limits WHERE bucket_key = 'enrollment-global'").get().count, 5);

  const weatherRequest = makeRequest('/api/weather');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal(await access.limitDisplayWeather(weatherRequest, db, '00000000-0000-4000-8000-000000000001'), true);
  }
  assert.equal(await access.limitDisplayWeather(weatherRequest, db, '00000000-0000-4000-8000-000000000001'), false);
});

test('pending enrollment polling is limited to 60 requests per minute', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const enrollment = await enroll(db);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    assert.equal((await finish(db, enrollment.cookie)).status, 202);
  }
  assert.equal((await finish(db, enrollment.cookie)).status, 429);
});

test('D1 failures return safe 503 responses or deny helper access', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const broken = {
    prepare() {
      throw new Error('synthetic private database failure');
    },
    async batch() {
      throw new Error('synthetic private database failure');
    },
  };

  const response = await call(broken, post('/api/enrollment'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(await access.getDisplaySession(makeRequest('/api/display', { headers: { Cookie: '__Host-sabio_display=' + 'a'.repeat(64) } }), broken), null);
});
