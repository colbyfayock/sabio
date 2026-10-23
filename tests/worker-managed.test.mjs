import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { LocalD1 } from './helpers/local-d1.mjs';

const result = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const origin = 'https://example.com';
const secondaryOrigin = 'https://alternate.example.com';
const vars = { APP_MODE: 'managed', APP_ORIGIN: origin, APP_ALLOWED_ORIGINS: `${origin},${secondaryOrigin}`, ACCESS_TEAM_DOMAIN: 'https://sample-team.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), OWNER_EMAIL: 'owner@example.com', NOTIFY_FROM_EMAIL: 'notify@example.com' };
const request = (path, body, headers = {}, base = origin) => new Request(base + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: base, 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('public preview cannot activate weather remotely, and invalid managed config fails closed', async () => {
  const env = { ASSETS: { fetch() { assert.fail('No asset fallback'); } } };
  assert.equal((await worker.fetch(request('/api/bootstrap', undefined, {}, 'http://127.0.0.1'), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/bootstrap'), env)).status, 503);
  assert.equal((await worker.fetch(request('/api/weather', { zipCode: '00000' }, { 'X-Forwarded-Host': 'localhost' }), env)).status, 503);
  assert.equal((await worker.fetch(request('/api/bootstrap'), { ...env, APP_MODE: 'managed' })).status, 503);
  assert.equal((await worker.fetch(request('/api/bootstrap'), { ...vars, APP_ALLOWED_ORIGINS: `${origin},http://alternate.example.com`, DB: {}, ASSETS: env.ASSETS })).status, 503);
  assert.equal((await worker.fetch(request('/api/bootstrap'), { ...vars, APP_ALLOWED_ORIGINS: `${origin},${origin}`, DB: {}, ASSETS: env.ASSETS })).status, 503);
});

test('managed custom and legacy origins are admitted independently while unlisted origins fail closed', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const env = { ...vars, DB: db, ASSETS: { async fetch() { return new Response('fixture'); } } };
  assert.deepEqual(await (await worker.fetch(request('/api/bootstrap'), env)).json(), { mode: 'managed', enrolled: false });
  assert.deepEqual(await (await worker.fetch(request('/api/bootstrap', undefined, {}, secondaryOrigin), env)).json(), { mode: 'managed', enrolled: false });
  assert.equal((await worker.fetch(request('/api/bootstrap', undefined, {}, 'https://unlisted.example.com'), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/enrollment', {}, {}, secondaryOrigin), env)).status, 201);
  assert.equal((await worker.fetch(request('/api/enrollment', {}, { Origin: 'https://unlisted.example.com' }, secondaryOrigin), env)).status, 403);
});

test('managed routing integrates real signed owner verification, original-browser pairing, protected weather and revocation', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const emails = [];
  const env = {
    ...vars,
    DB: db,
    EMAIL: { async send(message) { emails.push(message); return { messageId: 'synthetic' }; } },
    ASSETS: { async fetch() { return new Response('<!doctype html><title>Admin fixture</title>'); } },
  };
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ email: vars.OWNER_EMAIL, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(vars.ACCESS_TEAM_DOMAIN).setAudience(vars.ACCESS_AUDIENCE).setSubject('synthetic-owner').setIssuedAt(now).setExpirationTime(now + 600).sign(keys.privateKey);
  const ownerHeaders = { 'Cf-Access-Jwt-Assertion': jwt };
  let forecastRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.href === vars.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    if (url.hostname === 'geocoding-api.open-meteo.com') return Response.json({ results: [{ name: 'Sample Town', admin1: 'Sample State', country_code: 'US', postcodes: ['00000'], latitude: 40, longitude: -75 }] });
    assert.equal(url.hostname, 'api.open-meteo.com');
    forecastRequests++;
    return Response.json({ timezone: 'America/New_York', current: { time: now, temperature_2m: 70, weather_code: 0 }, current_units: { temperature_2m: '°F' }, daily: { temperature_2m_max: [75], temperature_2m_min: [60] }, daily_units: { temperature_2m_max: '°F', temperature_2m_min: '°F' } });
  });
  assert.deepEqual(await (await worker.fetch(request('/api/bootstrap'), env)).json(), { mode: 'managed', enrolled: false });
  assert.equal((await worker.fetch(request('/api/weather', { zipCode: '00000' }), env)).status, 401);
  assert.equal(forecastRequests, 0);
  assert.equal((await worker.fetch(request('/api/admin/displays', undefined, { 'Cf-Access-Authenticated-User-Email': vars.OWNER_EMAIL }), env)).status, 401);
  assert.equal((await worker.fetch(request('/admin.html', undefined, ownerHeaders), env)).status, 404);
  const admin = await worker.fetch(request('/admin', undefined, ownerHeaders), env);
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('Content-Security-Policy'), /^default-src 'none'/);
  assert.match(admin.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(admin.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(admin.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(admin.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(admin.headers.get('Cache-Control'), 'no-store');
  const alternateAdmin = await worker.fetch(request('/admin', undefined, ownerHeaders, secondaryOrigin), env);
  assert.equal(alternateAdmin.status, 200);
  assert.match(await alternateAdmin.text(), /Admin fixture/);
  const enrollment = await worker.fetch(request('/api/enrollment', {}), env);
  assert.equal(enrollment.status, 201);
  const { code } = await enrollment.json();
  const pending = enrollment.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await worker.fetch(request('/api/admin/approve', { code }, ownerHeaders), env)).status, 200);
  const completed = await worker.fetch(request('/api/enrollment/complete', {}, { Cookie: pending }), env);
  assert.equal(completed.status, 200);
  assert.equal(completed.headers.getSetCookie().length, 2);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, vars.OWNER_EMAIL);
  assert.equal(emails[0].from, vars.NOTIFY_FROM_EMAIL);
  assert.equal(emails[0].subject, 'Sabio: new display paired');
  assert.match(emails[0].text, /Display: [0-9a-f-]{36}/);
  assert.equal(emails[0].text.includes('127.0.0.1'), false);
  const sessionCookie = completed.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-sabio_display=')).split(';')[0];
  const displayHeaders = {
    Cookie: sessionCookie,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  };
  const firstBootstrap = await worker.fetch(request('/api/bootstrap', undefined, displayHeaders), env);
  assert.deepEqual(await firstBootstrap.json(), { mode: 'managed', enrolled: true });
  assert.equal(firstBootstrap.headers.get('Set-Cookie'), null, 'a fresh session is not reissued');
  // An active session inside the daily renewal window is extended and reissued.
  const nowSeconds = Math.floor(Date.now() / 1000);
  db.sqlite.prepare('UPDATE access_displays SET expires_at = ?').run(nowSeconds + 6 * 24 * 60 * 60);
  db.sqlite.prepare('UPDATE access_display_sessions SET expires_at = ?').run(nowSeconds + 6 * 24 * 60 * 60);
  const renewed = await worker.fetch(request('/api/bootstrap', undefined, displayHeaders), env);
  assert.deepEqual(await renewed.json(), { mode: 'managed', enrolled: true });
  assert.match(renewed.headers.get('Set-Cookie'), /^__Host-sabio_display=[a-f0-9]{64}; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  assert.equal(emails.length, 1, 'renewal does not send another pairing email');
  // Percent-encoded aliases resolve to the same route and enforce the same checks.
  const encodedBootstrap = await worker.fetch(request('/api/%62ootstrap', undefined, displayHeaders), env);
  assert.equal(encodedBootstrap.status, 200);
  assert.deepEqual(await encodedBootstrap.json(), { mode: 'managed', enrolled: true });
  assert.deepEqual(
    await (await worker.fetch(request('/api/%62ootstrap'), env)).json(),
    { mode: 'managed', enrolled: false },
  );
  assert.equal((await worker.fetch(request('/api%2Fadmin%2Fdisplays', undefined, ownerHeaders), env)).status, 400);
  assert.equal((await worker.fetch(request('/api%2Fdisplay', undefined, displayHeaders), env)).status, 400);
  assert.equal((await worker.fetch(request('/api/bootstrap', undefined, displayHeaders, 'https://other.example.com'), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/weather', { zipCode: '00000' }, displayHeaders, 'https://other.example.com'), env)).status, 403);
  const weather = await worker.fetch(request('/api/weather', { zipCode: '00000' }, displayHeaders), env);
  assert.equal(weather.status, 200);
  const forecast = await weather.json();
  assert.equal(forecast.timeZone, 'America/New_York');
  const { displays } = await (await worker.fetch(request('/api/admin/displays', undefined, ownerHeaders), env)).json();
  assert.match(emails[0].text, new RegExp(`Display: ${displays[0].id}`));
  assert.deepEqual(displays[0].device, { type: 'desktop', browser: 'Chrome 124.0', os: 'Linux' });
  assert.equal(typeof displays[0].lastSeenAt, 'number');
  assert.deepEqual(displays[0].weatherArea.label, 'Sample Town, Sample State');
  assert.equal(displays[0].weatherArea.timeZone, 'America/New_York');
  assert.equal(Object.hasOwn(displays[0], 'zipCode'), false);
  assert.equal(Object.hasOwn(displays[0].weatherArea, 'latitude'), false);
  assert.equal(Object.hasOwn(displays[0].weatherArea, 'longitude'), false);
  const revoked = await worker.fetch(request('/api/admin/revoke', { id: displays[0].id }, ownerHeaders), env);
  assert.equal(revoked.status, 204);
  const revokedList = await (await worker.fetch(request('/api/admin/displays', undefined, ownerHeaders), env)).json();
  assert.equal(revokedList.displays[0].revoked, true);
  assert.equal(typeof revokedList.displays[0].revokedAt, 'number');
  assert.equal((await worker.fetch(request('/api/weather', { zipCode: '00000' }, displayHeaders), env)).status, 401);
  assert.equal((await worker.fetch(request('/api/display', undefined, displayHeaders), env)).status, 401);
  assert.equal((await (await worker.fetch(request('/api/bootstrap', undefined, displayHeaders), env)).json()).enrolled, false);
  assert.equal(forecastRequests, 1);
});

test('allowed secondary origins still reject cross-origin weather and oversized allowlists', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const env = { ...vars, DB: db, ASSETS: { async fetch() { return new Response('fixture'); } } };

  assert.equal((await worker.fetch(request('/api/weather', { zipCode: '00000' }, { Origin: origin }, secondaryOrigin), env)).status, 403);
  const tooMany = [origin, secondaryOrigin, 'https://a.example.com', 'https://b.example.com', 'https://c.example.com'].join(',');
  assert.equal((await worker.fetch(request('/api/bootstrap'), { ...env, APP_ALLOWED_ORIGINS: tooMany })).status, 503);
});
