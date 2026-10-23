import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { LocalD1 } from './helpers/local-d1.mjs';

const ORIGIN = 'https://example.com';

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

const access = await load('src/access.ts');
const { default: worker } = await load('src/index.ts');

function request(path, options = {}) {
  return new Request(`${options.host ?? ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers: new Headers({
      Origin: options.origin ?? ORIGIN,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '127.0.0.1',
      ...options.headers,
    }),
    body: options.body,
  });
}

function post(path, body = '{}', headers = {}) {
  return request(path, { method: 'POST', body, headers });
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const cookieValue = () => randomBytes(32).toString('hex');

const managedEnv = (db) => ({
  APP_MODE: 'managed',
  APP_ORIGIN: ORIGIN,
  ACCESS_TEAM_DOMAIN: 'https://sample-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'a'.repeat(64),
  OWNER_EMAIL: 'owner@example.com',
  DB: db,
  ASSETS: { async fetch() { return new Response('<!doctype html><title>Fixture</title>'); } },
});

/** Insert a live, already-consumed display session and return its cookie value. */
function seedSession(db, now, { expiresAt = now + 7 * 24 * 60 * 60 } = {}) {
  const displayId = crypto.randomUUID();
  const enrollmentId = crypto.randomUUID();
  const token = cookieValue();
  db.sqlite.prepare(`INSERT INTO access_enrollments (id, display_id, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, 'consumed')`).run(enrollmentId, displayId, now - 60, expiresAt);
  db.sqlite.prepare('INSERT INTO access_displays (id, enrollment_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(displayId, enrollmentId, now - 60, expiresAt);
  db.sqlite.prepare('INSERT INTO access_display_sessions (token_hash, display_id, issued_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha(`session:${token}`), displayId, now - 60, expiresAt);
  return { displayId, token };
}

test('random valid-format display cookies drive one lookup and no cleanup batch', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const before = db.stats();

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await worker.fetch(request('/api/bootstrap', {
      headers: { Cookie: `__Host-sabio_display=${cookieValue()}` },
    }), managedEnv(db));
    assert.deepEqual(await response.json(), { mode: 'managed', enrolled: false });
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await access.handleAccessRequest(request('/api/display', {
      headers: { Cookie: `__Host-sabio_display=${cookieValue()}` },
    }), db, async () => true, ORIGIN);
    assert.equal(response.status, 401);
  }

  const after = db.stats();
  assert.equal(after.batches - before.batches, 0, 'invalid credentials must not run cleanup');
  assert.ok(after.queries - before.queries <= 55, `bounded to one lookup per request, saw ${after.queries - before.queries}`);
});

test('rejected, invalid, and rate-limited pairing claims do not run cleanup', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const call = (candidate) => access.handleAccessRequest(candidate, db, async () => true, ORIGIN);

  assert.equal((await call(post('/api/enrollment/claim', '{}', { 'Content-Type': 'text/plain' }))).status, 400);
  assert.equal((await call(post('/api/enrollment/claim', '{"unexpected":true}'))).status, 400);
  assert.equal((await call(post('/api/enrollment/claim', '{"code":"ABCDEFGHJK"}', { 'CF-Connecting-IP': '' }))).status, 403);
  assert.equal((await call(post('/api/enrollment/claim', '{"code":"ABCDEFGHJK"}', { Origin: 'https://other.example.com' }))).status, 403);
  assert.equal((await call(request('/api/enrollment/claim', { host: 'https://other.example.com' }))).status, 403);

  const rejected = db.stats();
  assert.equal(rejected.batches, 0, 'no batches for rejected requests');

  const now = Math.floor(Date.now() / 1000);
  const code = 'ABCDEFGHJK';
  db.sqlite.prepare(`INSERT INTO access_enrollments (id, display_id, pending_hash, code_hash, created_at, expires_at, status)
    VALUES (?, ?, NULL, ?, ?, ?, 'pending')`)
    .run(crypto.randomUUID(), crypto.randomUUID(), sha(`pairing:${code}`), now, now + 600);
  assert.equal((await call(post('/api/enrollment/claim', JSON.stringify({ code })))).status, 200);
  const claimed = db.stats();
  assert.equal(claimed.batches - rejected.batches, 2, 'one claim batch plus one bounded cleanup');

  assert.equal((await call(post('/api/enrollment/claim', JSON.stringify({ code })))).status, 401);
  const replayed = db.stats();
  assert.equal(replayed.batches - claimed.batches, 1, 'replays run the claim batch but never cleanup');

  const invalidHeaders = { 'CF-Connecting-IP': '127.0.0.2' };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await call(post('/api/enrollment/claim', JSON.stringify({ code: 'ZZZZZZZZZZ' }), invalidHeaders))).status, 401);
  }
  const invalid = db.stats();
  assert.equal(invalid.batches - replayed.batches, 20, 'invalid claims run only their claim batch');
  assert.equal((await call(post('/api/enrollment/claim', JSON.stringify({ code: 'ZZZZZZZZZZ' }), invalidHeaders))).status, 429);
  assert.equal(db.stats().batches, invalid.batches, 'rate-limited requests do not run cleanup');
});

test('cleanup stays bounded, removes expired rows in foreign-key-safe order, and keeps live access', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000);
  const live = seedSession(db, now);

  for (let index = 0; index < 60; index += 1) {
    db.sqlite.prepare('INSERT INTO access_rate_limits (bucket_key, window_start, count, expires_at) VALUES (?, ?, 1, ?)')
      .run(`expired-${index}`, now - 120, now - 60);
  }
  db.sqlite.prepare(`INSERT INTO access_enrollments (id, display_id, pending_hash, code_hash, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(crypto.randomUUID(), crypto.randomUUID(), sha('pending-x'), sha('code-x'), now - 120, now - 60);

  const before = db.stats();
  await access.cleanupExpired(db, now);
  assert.equal(db.stats().batches - before.batches, 1);
  assert.ok(db.stats().statements - before.statements <= 6, 'single bounded batch');

  const remaining = db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_rate_limits').get().count;
  assert.equal(remaining, 10, 'at most 50 rate-limit rows per pass');
  await access.cleanupExpired(db, now);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_rate_limits').get().count, 0);

  assert.ok(await access.getDisplaySession(
    request('/api/display', { headers: { Cookie: `__Host-sabio_display=${live.token}` } }), db));
  assert.equal((await worker.fetch(request('/api/bootstrap', {
    headers: { Cookie: `__Host-sabio_display=${live.token}` },
  }), managedEnv(db))).status, 200);
});

test('scheduled handler runs one bounded cleanup batch independently of traffic', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000);
  seedSession(db, now, { expiresAt: now - 60 });
  db.sqlite.prepare('INSERT INTO access_rate_limits (bucket_key, window_start, count, expires_at) VALUES (?, ?, 1, ?)')
    .run('expired', now - 120, now - 60);

  const before = db.stats();
  await worker.scheduled({ cron: '*/15 * * * *' }, { DB: db });
  assert.equal(db.stats().batches - before.batches, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_rate_limits').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_display_sessions').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_displays').get().count, 0);
});

test('authenticated bootstrap polling is bounded without cleanup work', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000);
  const { token } = seedSession(db, now);
  const headers = { Cookie: `__Host-sabio_display=${token}` };

  const before = db.stats();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await worker.fetch(request('/api/bootstrap', { headers }), managedEnv(db));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mode: 'managed', enrolled: true });
  }
  assert.equal((await worker.fetch(request('/api/bootstrap', { headers }), managedEnv(db))).status, 429);

  const after = db.stats();
  assert.equal(after.batches - before.batches, 0, 'bootstrap never runs cleanup');
  assert.ok(after.queries - before.queries <= 60, 'one session read plus one budget write per poll');
});
