import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function call(db, request, verifyAdmin = async () => true, origin = ORIGIN, notifyDisplay) {
  return access.handleAccessRequest(request, db, verifyAdmin, origin, notifyDisplay);
}

async function pair(db, verifyAdmin = async () => true) {
  const response = await call(db, post('/api/admin/pairing', '{}'), verifyAdmin);
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.match(data.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  assert.ok(data.expiresAt > Math.floor(Date.now() / 1000));
  return { code: data.code, expiresAt: data.expiresAt };
}

async function claim(db, code, headers = {}, notifyDisplay) {
  return call(db, post('/api/enrollment/claim', JSON.stringify({ code }), headers), async () => true, ORIGIN, notifyDisplay);
}

function displayCookie(response) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-sabio_display='));
  assert.ok(cookie);
  return cookie;
}

test('access routes reject wrong hosts, methods, queries, CSRF, and malformed bodies', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  assert.equal(await call(db, makeRequest('/not-an-access-route')), null);
  for (const path of ['/api/enrollment', '/api/enrollment/claim', '/api/admin/unknown', '/api/display/anything']) {
    const wrongHost = makeRequest(path, { host: 'https://other.example.com' });
    assert.equal((await call(db, wrongHost)).status, 403);
  }
  for (const path of ['/api/enrollment', '/api/enrollment/anything', '/api/admin/unknown', '/api/admin/approve', '/api/display/anything']) {
    assert.equal((await call(db, makeRequest(path))).status, 404);
  }
  assert.equal((await call(db, makeRequest('/api/enrollment/claim'))).status, 405);
  assert.equal((await call(db, makeRequest('/api/admin/pairing'))).status, 405);
  assert.equal((await call(db, post('/api/enrollment/claim?code=secret', JSON.stringify({ code: 'ABCDEFGHJK' })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 'ABCDEFGHJK' }), { Origin: 'https://other.example.com' }))).status, 403);
  assert.equal((await call(db, post('/api/admin/pairing', '{}', { Origin: 'https://other.example.com' }))).status, 403);
  assert.equal((await call(db, post('/api/enrollment/claim', '{}'))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ unexpected: true })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ unexpected: 'x' })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 123 })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 'ABCDEFGHJK', extra: 'x' })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 'ABCDEFGHJK' }), { 'Content-Type': 'text/plain' }))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 'x'.repeat(600) })))).status, 400);
  assert.equal((await call(db, post('/api/enrollment/claim', JSON.stringify({ code: 'ABCDEFGHJK' }), { 'CF-Connecting-IP': '' }))).status, 403);
  assert.equal((await call(db, post('/api/admin/pairing'), async () => true, 'http://example.com')).status, 403);
});

test('an owner-issued pairing code creates exactly one display session and cannot be reused', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  const pairing = await pair(db);
  const stored = db.sqlite.prepare('SELECT code_hash, pending_hash FROM access_enrollments').get();
  assert.equal(stored.code_hash.length, 64);
  assert.notEqual(stored.code_hash, pairing.code);
  assert.equal(stored.pending_hash, null);

  const claimed = await claim(db, pairing.code.toLowerCase());
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { status: 'paired' });
  const cookies = claimed.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const session = displayCookie(claimed);
  assert.match(session, /; Secure; HttpOnly; SameSite=Strict/);
  assert.match(session, /; Path=\//);
  const sessionCookie = session.split(';', 1)[0];

  const display = await call(db, makeRequest('/api/display', { headers: { Cookie: sessionCookie } }));
  assert.equal(display.status, 200);

  const consumed = db.sqlite.prepare('SELECT status, code_hash FROM access_enrollments').get();
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.code_hash, null);
  assert.equal((await claim(db, pairing.code)).status, 401);
});

test('only the owner can generate a pairing code, and a newer code invalidates the older one', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  assert.equal((await call(db, post('/api/admin/pairing', '{}'), async () => false)).status, 401);
  const first = await pair(db);
  const second = await pair(db);
  assert.equal((await claim(db, first.code)).status, 401);
  assert.equal((await claim(db, second.code)).status, 200);
});

test('legacy display-initiated pending rows cannot be claimed through the owner pairing endpoint', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const code = 'ABCDEFGHJK';
  const now = Math.floor(Date.now() / 1000);
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  db.sqlite.prepare(`INSERT INTO access_enrollments
    (id, display_id, pending_hash, code_hash, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(crypto.randomUUID(), crypto.randomUUID(), digest('pending:legacy'), digest(`pairing:${code}`), now, now + 600);

  assert.equal((await claim(db, code)).status, 401);
  assert.equal(db.sqlite.prepare('SELECT status FROM access_enrollments').get().status, 'pending');
});

test('admin can list, and revoke a display session', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());

  const pairing = await pair(db);
  const claimed = await claim(db, pairing.code);
  assert.equal(claimed.status, 200);
  const sessionCookie = displayCookie(claimed).split(';', 1)[0];

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
  assert.equal((await (await call(db, makeRequest('/api/admin/displays?scope=history'))).json()).displays[0].revoked, true);
  assert.equal(typeof (await (await call(db, makeRequest('/api/admin/displays?scope=history'))).json()).displays[0].revokedAt, 'number');
});

test('owner may set and clear an optional display nickname without admitting markup or another display', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const first = await pair(db);
  assert.equal((await claim(db, first.code)).status, 200);
  const second = await pair(db);
  assert.equal((await claim(db, second.code)).status, 200);
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

test('pairing-code expiry and display-session expiry deny access', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const expired = await pair(db);
  db.sqlite.prepare('UPDATE access_enrollments SET expires_at = ? WHERE status = ?')
    .run(Math.floor(Date.now() / 1000) - 1, 'pending');
  assert.equal((await claim(db, expired.code)).status, 401);

  const current = await pair(db);
  const claimed = await claim(db, current.code);
  assert.equal(claimed.status, 200);
  const sessionCookie = displayCookie(claimed).split(';', 1)[0];
  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await call(db, makeRequest('/api/display', { headers: { Cookie: sessionCookie } }))).status, 401);
});

test('display scope comes only from the session, and revoking one browser does not revoke another', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const credentials = [];
  for (let index = 0; index < 2; index++) {
    const pairing = await pair(db);
    const claimed = await claim(db, pairing.code);
    assert.equal(claimed.status, 200);
    const cookie = displayCookie(claimed).split(';', 1)[0];
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

test('concurrent claims give exactly one request a session', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const pairing = await pair(db);

  const responses = await Promise.all([claim(db, pairing.code), claim(db, pairing.code)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  const winners = responses.filter((response) => response.status === 200);
  assert.equal(winners[0].headers.getSetCookie().filter((value) => value.startsWith('__Host-sabio_display=')).length, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_display_sessions').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_displays').get().count, 1);
});

test('pairing claims and weather are rate-limited per IP and display', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const pairing = await pair(db);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await claim(db, 'ZZZZZZZZZZ')).status, 401);
  }
  assert.equal((await claim(db, 'ZZZZZZZZZZ')).status, 429);
  assert.equal((await claim(db, pairing.code)).status, 429);

  const weatherRequest = makeRequest('/api/weather');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal(await access.limitDisplayWeather(weatherRequest, db, '00000000-0000-4000-8000-000000000001'), true);
  }
  assert.equal(await access.limitDisplayWeather(weatherRequest, db, '00000000-0000-4000-8000-000000000001'), false);
});

test('owner pairing-code generation is rate-limited', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  for (let attempt = 0; attempt < 10; attempt += 1) await pair(db);
  const limited = await call(db, post('/api/admin/pairing', '{}'));
  assert.equal(limited.status, 429);
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

  const response = await call(broken, post('/api/enrollment/claim', JSON.stringify({ code: 'ABCDEFGHJK' })));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(await access.getDisplaySession(makeRequest('/api/display', { headers: { Cookie: '__Host-sabio_display=' + 'a'.repeat(64) } }), broken), null);
});

test('active display sessions renew daily, reissue the cookie, and never revive revoked or expired rows', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const pairing = await pair(db);
  const claimed = await claim(db, pairing.code);
  assert.equal(claimed.status, 200);
  const sessionCookie = displayCookie(claimed).split(';', 1)[0];
  const token = sessionCookie.split('=')[1];
  const displayId = db.sqlite.prepare('SELECT id FROM access_displays').get().id;
  const now = Math.floor(Date.now() / 1000);
  const idle = 7 * 24 * 60 * 60;
  const request = makeRequest('/api/bootstrap', { headers: { Cookie: sessionCookie } });

  const fresh = await access.getDisplaySession(request, db);
  assert.equal(await access.refreshDisplaySession(request, db, fresh), null);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM access_displays').get().expires_at, fresh.expiresAt);

  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(now + idle - 24 * 60 * 60);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ?').run(now + idle - 24 * 60 * 60);
  const due = await access.getDisplaySession(request, db);
  const refreshed = await Promise.all([
    access.refreshDisplaySession(request, db, due),
    access.refreshDisplaySession(request, db, due),
  ]);
  assert.deepEqual(refreshed.filter(Boolean), [
    `__Host-sabio_display=${token}; Max-Age=${idle}; Path=/; Secure; HttpOnly; SameSite=Strict`,
  ]);
  const renewedUntil = db.sqlite.prepare('SELECT expires_at FROM access_display_sessions').get().expires_at;
  assert.ok(renewedUntil >= now + idle && renewedUntil <= Math.floor(Date.now() / 1000) + idle);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM access_displays').get().expires_at, renewedUntil);

  const current = await access.getDisplaySession(request, db);
  assert.equal(await access.refreshDisplaySession(request, db, { ...current, expiresAt: current.expiresAt }), null);
  assert.equal(await access.refreshDisplaySession(makeRequest('/api/bootstrap'), db, { id: displayId, expiresAt: now + idle - 60 }), null);

  db.sqlite.prepare('UPDATE access_displays SET revoked_at = ?').run(now);
  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(now + idle - 24 * 60 * 60);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ?').run(now + idle - 24 * 60 * 60);
  assert.equal(await access.getDisplaySession(request, db), null);
  assert.equal(await access.refreshDisplaySession(request, db, { id: displayId, expiresAt: now + idle - 60 }), null);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM access_displays').get().expires_at, now + idle - 24 * 60 * 60);

  db.sqlite.prepare('UPDATE access_displays SET revoked_at = NULL, expires_at = ?').run(now - 1);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ?').run(now + idle - 24 * 60 * 60);
  assert.equal(await access.refreshDisplaySession(request, db, { id: displayId, expiresAt: now + idle - 60 }), null);
  assert.equal(db.sqlite.prepare('SELECT expires_at FROM access_displays').get().expires_at, now - 1);
});

test('the owner is notified exactly once after a session is actually issued', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const notices = [];
  const notify = async (notice) => { notices.push(notice); };
  const pairing = await pair(db);

  const claimed = await claim(db, pairing.code, {}, notify);
  assert.equal(claimed.status, 200);
  assert.equal(notices.length, 1);
  assert.match(notices[0].displayId, /^[0-9a-f-]{36}$/);
  assert.equal(notices[0].at, Math.floor(Date.now() / 1000));
  assert.equal(notices[0].browser, null);
  assert.equal(notices[0].os, null);

  assert.equal((await claim(db, pairing.code, {}, notify)).status, 401);
  assert.equal(notices.length, 1, 'replays never notify');

  const second = await pair(db);
  const failing = await claim(db, second.code, {}, async () => { throw new Error('synthetic mail failure'); });
  assert.equal(failing.status, 200, 'notification failure must not block session issuance');
  assert.equal(failing.headers.getSetCookie().filter((value) => value.startsWith('__Host-sabio_display=')).length, 1);
});

test('bounded keyset pages discover all active and mixed history rows with tied timestamps', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000);
  const ids = { active: [], history: [] };
  for (let i = 1; i <= 285; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const scope = i <= 135 ? 'active' : 'history';
    ids[scope].push(id);
    const expired = i > 210;
    db.sqlite.prepare("INSERT INTO access_enrollments (id, display_id, created_at, expires_at, status) VALUES (?, ?, ?, ?, 'consumed')").run(id, id, now - i, now + 600);
    db.sqlite.prepare('INSERT INTO access_displays (id, enrollment_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)').run(id, id, now - Math.floor(i / 17), expired ? now - 1 : now + 600, scope === 'history' && !expired ? now : null);
    db.sqlite.prepare('INSERT INTO access_display_sessions (token_hash, display_id, issued_at, expires_at) VALUES (?, ?, ?, ?)').run(createHash('sha256').update(`session:${String(i).padStart(64, '0')}`).digest('hex'), id, now - i, expired ? now - 1 : now + 600);
  }
  for (const scope of ['active', 'history']) {
    const found = [];
    let cursor = null;
    do {
      const response = await call(db, makeRequest(`/api/admin/displays?scope=${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const page = await response.json();
      assert.ok(page.displays.length <= 100);
      found.push(...page.displays.map((row) => row.id));
      if (scope === 'history') assert.ok(page.displays.every((row) => row.expired || row.revoked));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(new Set(found), new Set(ids[scope]));
    assert.equal(found.length, ids[scope].length, 'ties never duplicate rows');
  }
  const oldest = ids.active.at(-1);
  assert.equal((await call(db, post('/api/admin/revoke', JSON.stringify({ id: oldest })))).status, 204);
  const credential = (i) => makeRequest('/api/display', { headers: { Cookie: `__Host-sabio_display=${String(i).padStart(64, '0')}` } });
  assert.equal((await call(db, credential(135))).status, 401);
  assert.equal((await call(db, credential(1))).status, 200);
});

test('list cursors reject malformed, duplicate and cross-scope parameters before storage', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const valid = 'v1:active:1792670400:00000000-0000-4000-8000-000000000001';
  const invalid = ['?', '?scope=', '?scope=all', '?scope=active&scope=history', '?limit=100', '?&&', '?scope=active&', '?cursor=', '?cursor=x',
    `?scope=history&cursor=${valid}`, `?cursor=${valid}&cursor=${valid}`, `?cursor=${valid.replace('1792670400', '01')}`,
    `?cursor=${valid.replace('1792670400', '9007199254740992')}`, `?cursor=${valid}x`, '?cursor=' + 'a'.repeat(201)];
  const before = db.stats();
  for (const query of invalid) assert.equal((await call(db, makeRequest('/api/admin/displays' + query))).status, 400, query);
  assert.deepEqual(db.stats(), before);
  for (const route of ['/api/display', '/api/admin/revoke', '/api/enrollment/claim', '/api/admin/pairing', '/api/admin/label']) {
    assert.equal((await call(db, makeRequest(route + '?scope=active'))).status, 400);
  }
  assert.equal((await call(db, makeRequest('/api/admin/displays?scope=active'), async () => false)).status, 401);
  assert.equal((await call(db, makeRequest('/api/admin/displays?scope=history', { headers: { Origin: 'https://other.example' } }))).status, 403);
  assert.equal((await call(db, post('/api/admin/displays?scope=active'))).status, 405);
  const stale = await (await call(db, makeRequest('/api/admin/displays?cursor=' + valid))).json();
  assert.deepEqual(stale.displays, []);
  assert.equal(stale.nextCursor, null);
});

test('renewal only updates the presented credential and its own active display', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const a = displayCookie(await claim(db, (await pair(db)).code)).split(';')[0];
  const b = displayCookie(await claim(db, (await pair(db)).code)).split(';')[0];
  const now = Math.floor(Date.now() / 1000);
  const due = now + 6 * 86400;
  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(due);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ?').run(due);
  const requestA = makeRequest('/api/bootstrap', { headers: { Cookie: a } });
  const requestB = makeRequest('/api/bootstrap', { headers: { Cookie: b } });
  const sessionA = await access.getDisplaySession(requestA, db);
  assert.equal(await access.refreshDisplaySession(requestB, db, sessionA), null);
  assert.ok(db.sqlite.prepare('SELECT expires_at FROM access_displays').all().every((r) => r.expires_at === due));
  assert.ok(db.sqlite.prepare('SELECT expires_at FROM access_display_sessions').all().every((r) => r.expires_at === due));
  assert.ok(await access.refreshDisplaySession(requestA, db, sessionA));
});

test('active listing requires a usable session, and history reports missing or expired credentials', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  await claim(db, (await pair(db)).code);
  await claim(db, (await pair(db)).code);
  const rows = db.sqlite.prepare('SELECT display_id FROM access_display_sessions ORDER BY display_id').all();
  db.sqlite.prepare('DELETE FROM access_display_sessions WHERE display_id = ?').run(rows[0].display_id);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ? WHERE display_id = ?').run(Math.floor(Date.now() / 1000) - 1, rows[1].display_id);
  const active = await (await call(db, makeRequest('/api/admin/displays'))).json();
  assert.deepEqual(active.displays, []);
  const history = await (await call(db, makeRequest('/api/admin/displays?scope=history'))).json();
  assert.equal(history.displays.length, 2);
  assert.equal(history.displays.find((r) => r.id === rows[0].display_id).inactive, true);
  assert.equal(history.displays.find((r) => r.id === rows[1].display_id).expired, true);
  assert.equal(JSON.stringify(history).includes('token'), false);
});
