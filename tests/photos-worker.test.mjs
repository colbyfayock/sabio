import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { LocalD1 } from './helpers/local-d1.mjs';

const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const origin = 'https://example.com';
const vars = {
  APP_MODE: 'managed', APP_ORIGIN: origin, APP_ALLOWED_ORIGINS: origin,
  ACCESS_TEAM_DOMAIN: 'https://photos-test.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), OWNER_EMAIL: 'owner@example.com',
  GOOGLE_PHOTOS_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_PHOTOS_CLIENT_SECRET: 'test-client-secret',
  PHOTO_ENCRYPTION_KEY: 'b'.repeat(64),
};
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
const sanitizedJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);

function request(path, body, headers = {}, base = origin) {
  return new Request(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, 'CF-Connecting-IP': '127.0.0.1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { bytes: new Uint8Array(value), contentType: options.httpMetadata.contentType });
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: new Response(value.bytes).body, size: value.bytes.byteLength } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

async function ownerToken() {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'photo-test-key', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: vars.OWNER_EMAIL, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(vars.ACCESS_TEAM_DOMAIN).setAudience(vars.ACCESS_AUDIENCE).setSubject('synthetic-owner')
    .setIssuedAt(now).setExpirationTime(now + 600).sign(keys.privateKey);
  return { token, jwk };
}

test('Google Picker import stores private images, encrypts transient credentials, and enforces display access', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const bucket = makeBucket();
  const { token, jwk } = await ownerToken();
  const ownerHeaders = { 'Cf-Access-Jwt-Assertion': token };
  let selected = false;
  let deleteCount = 0;
  let holdSessionResponse = false;
  let signalSessionResponse;
  let releaseSessionResponse;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.href === `${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_secret'), vars.GOOGLE_PHOTOS_CLIENT_SECRET);
      if (form.get('grant_type') === 'refresh_token') {
        assert.equal(form.get('refresh_token'), 'persistent-refresh-token');
        return Response.json({ access_token: 'refreshed-access-token', expires_in: 3600, token_type: 'Bearer' });
      }
      return Response.json({ access_token: 'transient-access-token', refresh_token: 'persistent-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly' });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      assert.equal(new URLSearchParams(init.body).get('token'), 'persistent-refresh-token');
      return new Response(null, { status: 200 });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions' && init.method === 'POST') {
      assert.ok(['Bearer transient-access-token', 'Bearer refreshed-access-token'].includes(init.headers.Authorization));
      return Response.json({ id: 'session-private-id', pickerUri: 'https://photos.google.com/picker?session=session-private-id', pollingConfig: { pollInterval: '5s' } });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions/session-private-id' && init.method !== 'DELETE') {
      if (holdSessionResponse) {
        holdSessionResponse = false;
        signalSessionResponse();
        await new Promise((resolve) => { releaseSessionResponse = resolve; });
      }
      return Response.json({ id: 'session-private-id', mediaItemsSet: selected });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions/session-private-id' && init.method === 'DELETE') {
      deleteCount += 1;
      return new Response(null, { status: 204 });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/mediaItems') {
      return Response.json({ mediaItems: [{ id: 'private-google-media-id', mediaFile: { baseUrl: 'https://lh3.googleusercontent.com/private-media', mimeType: 'image/jpeg' } }] });
    }
    if (url.hostname === 'lh3.googleusercontent.com') {
      assert.equal(url.pathname.endsWith('=w2048-h1280'), true);
      assert.equal(init.headers.Authorization, 'Bearer transient-access-token');
      return new Response(jpegBytes, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    assert.fail(`Unexpected mocked request host/path: ${url.hostname}${url.pathname}`);
  });
  const env = { ...vars, DB: db, PHOTO_BUCKET: bucket, ASSETS: { async fetch() { return new Response('admin'); } } };

  assert.equal((await worker.fetch(request('/api/admin/photos/connect', {}), env)).status, 401, 'unverified callers cannot start OAuth');
  const connected = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  assert.equal(connected.status, 200);
  const authorizationUrl = new URL((await connected.json()).authorizationUrl);
  assert.equal(authorizationUrl.hostname, 'accounts.google.com');
  assert.equal(authorizationUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly');
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizationUrl.searchParams.get('prompt'), 'consent');
  const state = authorizationUrl.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{64}$/);

  const callback = await worker.fetch(request(`/api/admin/photos/callback?code=synthetic-code&state=${state}&iss=${encodeURIComponent('https://accounts.google.com')}`, undefined, ownerHeaders), env);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('Location'), '/admin?photos=connected');
  assert.equal(fetchMock.mock.calls.filter((call) => new URL(call.arguments[0].url || call.arguments[0]).hostname === 'oauth2.googleapis.com').length, 1);
  assert.equal(fetchMock.mock.calls.filter((call) => new URL(call.arguments[0].url || call.arguments[0]).hostname === 'photospicker.googleapis.com').length, 1);
  const storedJob = db.sqlite.prepare('SELECT * FROM photo_imports').get();
  assert.ok(storedJob);
  assert.equal(storedJob.access_token_ciphertext.includes('transient-access-token'), false);
  assert.equal(storedJob.google_session_ciphertext.includes('session-private-id'), false);
  assert.equal(storedJob.picker_uri_ciphertext.includes('photos.google.com'), false);
  assert.equal((await worker.fetch(request(`/api/admin/photos/callback?code=synthetic-code&state=${state}&iss=${encodeURIComponent('https://accounts.google.com')}`, undefined, ownerHeaders), env)).headers.get('Location'), '/admin?photos=expired', 'OAuth state is single use');
  const storedConnection = db.sqlite.prepare('SELECT refresh_token_ciphertext FROM google_photo_connections WHERE id = 1').get();
  assert.ok(storedConnection);
  assert.equal(storedConnection.refresh_token_ciphertext.includes('persistent-refresh-token'), false);

  const listed = await worker.fetch(request('/api/admin/photos', undefined, ownerHeaders), env);
  assert.equal(listed.status, 200);
  const library = await listed.json();
  assert.equal(library.googleConnected, true);
  const activeImport = library.activeImport;
  assert.equal(activeImport.pickerUri, 'https://photos.google.com/picker?session=session-private-id');
  assert.equal((await worker.fetch(request(`/api/admin/photos/status?id=${activeImport.id}`, undefined, ownerHeaders), env)).status, 200);
  selected = true;
  const status = await worker.fetch(request(`/api/admin/photos/status?id=${activeImport.id}`, undefined, ownerHeaders), env);
  assert.equal((await status.json()).mediaItemsSet, true);

  let signalReady;
  const sessionReady = new Promise((resolve) => { signalReady = resolve; });
  holdSessionResponse = true;
  signalSessionResponse = signalReady;
  const importRequest = worker.fetch(request('/api/admin/photos/import', { jobId: activeImport.id }, ownerHeaders), env);
  await sessionReady;
  const competingImport = await worker.fetch(request('/api/admin/photos/import', { jobId: activeImport.id }, ownerHeaders), env);
  assert.equal(competingImport.status, 409, 'a concurrent import cannot bypass the database lease');
  releaseSessionResponse();
  const imported = await importRequest;
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { done: true, importedCount: 1 });
  assert.equal(bucket.objects.size, 1);
  assert.equal(deleteCount, 1, 'Google Picker session is deleted after import');
  const photo = db.sqlite.prepare('SELECT id, object_key, content_type, size_bytes FROM photo_items').get();
  assert.equal(photo.content_type, 'image/jpeg');
  assert.equal(photo.size_bytes, sanitizedJpegBytes.byteLength);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM photo_imports').get().count, 0, 'transient OAuth data is removed');

  const photoList = await worker.fetch(request('/api/admin/photos', undefined, ownerHeaders), env);
  const privateList = await photoList.json();
  assert.equal(privateList.photos.length, 1);
  assert.equal(JSON.stringify(privateList).includes('googleusercontent.com'), false, 'source base URLs are never returned to the browser');
  const pickerAgain = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  assert.deepEqual(await pickerAgain.json(), { status: 'picker_ready' }, 'an existing Google connection starts a new Picker without OAuth');
  const disconnect = await worker.fetch(request('/api/admin/photos/disconnect', {}, ownerHeaders), env);
  assert.deepEqual(await disconnect.json(), { disconnected: true, googleRevoked: true });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM google_photo_connections').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM photo_imports').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM photo_items').get().count, 1, 'disconnect retains app-owned imported photos');
  assert.equal(deleteCount, 2, 'disconnect deletes the active Google Picker session');
  const pairing = await worker.fetch(request('/api/admin/pairing', {}, ownerHeaders), env);
  const { code } = await pairing.json();
  const claim = await worker.fetch(request('/api/enrollment/claim', { code }), env);
  const sessionCookie = claim.headers.getSetCookie().find((value) => value.startsWith('__Host-sabio_display=')).split(';')[0];
  const displayHeaders = { Cookie: sessionCookie };
  const unauthorized = await worker.fetch(request('/api/display/photos', undefined, {}, 'https://alternate.example.com'), env);
  assert.equal(unauthorized.status, 403, 'unlisted origins cannot read photos');
  assert.equal((await worker.fetch(request('/api/display/photos'), env)).status, 401, 'unpaired callers cannot list photos');
  const displayList = await worker.fetch(request('/api/display/photos', undefined, displayHeaders), env);
  assert.equal(displayList.status, 200);
  assert.equal(displayList.headers.get('Cache-Control'), 'no-store');
  const displayItems = await displayList.json();
  assert.equal(displayItems.photos.length, 1);
  const image = await worker.fetch(request(displayItems.photos[0].url, undefined, displayHeaders), env);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(image.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), sanitizedJpegBytes);

  const displayId = db.sqlite.prepare('SELECT id FROM access_displays LIMIT 1').get().id;
  await worker.fetch(request('/api/admin/revoke', { id: displayId }, ownerHeaders), env);
  assert.equal((await worker.fetch(request(displayItems.photos[0].url, undefined, displayHeaders), env)).status, 401, 'revocation blocks later image requests');
  const deleted = await worker.fetch(request('/api/admin/photos/delete', { photoId: photo.id }, ownerHeaders), env);
  assert.equal(deleted.status, 204);
  assert.equal(bucket.objects.size, 0, 'removing a photo deletes its private R2 object');
  assert.equal((await (await worker.fetch(request('/api/admin/photos', undefined, ownerHeaders), env)).json()).photos.length, 0);
});

test('photo administration rejects cross-origin requests, malformed callback state, and videos', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const { token, jwk } = await ownerToken();
  const ownerHeaders = { 'Cf-Access-Jwt-Assertion': token };
  let selected = true;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.href === `${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') return Response.json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' });
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions' && init.method === 'POST') {
      return Response.json({ id: 'video-session', pickerUri: 'https://photos.google.com/picker/video-session' });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions/video-session') return Response.json({ mediaItemsSet: selected });
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/mediaItems') {
      return Response.json({ mediaItems: [{ id: 'video-id', mediaFile: { baseUrl: 'https://lh3.googleusercontent.com/video', mimeType: 'video/mp4' } }] });
    }
    if (url.hostname === 'photospicker.googleapis.com' && init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.fail(`Unexpected mocked request host/path: ${url.hostname}${url.pathname}`);
  });
  const env = {
    ...vars, DB: db, PHOTO_BUCKET: makeBucket(), ASSETS: { async fetch() { return new Response('admin'); } },
  };
  assert.equal((await worker.fetch(request('/api/admin/photos/connect', {}, { ...ownerHeaders, Origin: 'https://attacker.example' }), env)).status, 403);
  assert.equal((await worker.fetch(request('/api/admin/photos/callback?code=missing-state', undefined, ownerHeaders), env)).status, 400);
  assert.equal((await worker.fetch(request('/api/admin/photos/callback?code=code&state=' + 'c'.repeat(64) + '&iss=https%3A%2F%2Fevil.example', undefined, ownerHeaders), env)).status, 400,
    'callback issuer must be Google');

  const connect = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  const state = new URL((await connect.json()).authorizationUrl).searchParams.get('state');
  await worker.fetch(request(`/api/admin/photos/callback?code=code&state=${state}`, undefined, ownerHeaders), env);
  const active = (await (await worker.fetch(request('/api/admin/photos', undefined, ownerHeaders), env)).json()).activeImport;
  const response = await worker.fetch(request('/api/admin/photos/import', { jobId: active.id }, ownerHeaders), env);
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: 'unsupported_media' });
  assert.equal(env.PHOTO_BUCKET.objects.size, 0);
});

test('Picker API permission failures are distinguished from expired Google authorization', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const { token, jwk } = await ownerToken();
  const ownerHeaders = { 'Cf-Access-Jwt-Assertion': token };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.href === `${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const grantType = new URLSearchParams(init.body).get('grant_type');
      return Response.json(grantType === 'refresh_token'
        ? { access_token: 'refreshed-token', expires_in: 3600, token_type: 'Bearer' }
        : { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions' && init.method === 'POST') {
      return Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic disabled API error' } }, { status: 403 });
    }
    assert.fail(`Unexpected mocked request host/path: ${url.hostname}${url.pathname}`);
  });
  const env = { ...vars, DB: db, PHOTO_BUCKET: makeBucket(), ASSETS: { async fetch() { return new Response('admin'); } } };
  const connect = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  const state = new URL((await connect.json()).authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(request(`/api/admin/photos/callback?code=code&state=${state}&iss=${encodeURIComponent('https://accounts.google.com')}`, undefined, ownerHeaders), env);
  assert.equal(callback.headers.get('Location'), '/admin?photos=google_photos_api_unavailable');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM google_photo_connections').get().count, 1, 'connection stays available for retry');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM photo_imports').get().count, 0);

  const picker = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  assert.equal(picker.status, 502);
  assert.deepEqual(await picker.json(), { error: 'google_photos_api_unavailable' }, 'API configuration errors are not reported as revoked grants');
});

test('unknown Picker API errors retain only the provider HTTP status for troubleshooting', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const { token, jwk } = await ownerToken();
  const ownerHeaders = { 'Cf-Access-Jwt-Assertion': token };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.href === `${vars.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(init.body);
      return Response.json(form.get('grant_type') === 'refresh_token'
        ? { access_token: 'refreshed', expires_in: 3600, token_type: 'Bearer' }
        : { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.hostname === 'photospicker.googleapis.com' && url.pathname === '/v1/sessions' && init.method === 'POST') {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Synthetic API error' } }, { status: 400 });
    }
    assert.fail(`Unexpected mocked request host/path: ${url.hostname}${url.pathname}`);
  });
  const env = { ...vars, DB: db, PHOTO_BUCKET: makeBucket(), ASSETS: { async fetch() { return new Response('admin'); } } };
  const connect = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  const state = new URL((await connect.json()).authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(request(`/api/admin/photos/callback?code=code&state=${state}&iss=${encodeURIComponent('https://accounts.google.com')}`, undefined, ownerHeaders), env);
  assert.equal(callback.headers.get('Location'), '/admin?photos=google_picker_http_400');
  const retry = await worker.fetch(request('/api/admin/photos/connect', {}, ownerHeaders), env);
  assert.equal(retry.status, 502);
  assert.deepEqual(await retry.json(), { error: 'google_picker_http_400' });
});
