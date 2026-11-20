import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { LocalD1 } from './helpers/local-d1.mjs';

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
const { default: worker } = await load('src/index.ts');
const { handleAccessRequest } = await load('src/access.ts');
const origin = 'https://example.com';
const alternate = 'https://alternate.example.com';
const allow = { async limit() { return { success: true }; } };
const deny = { async limit() { return { success: false }; } };
const unavailable = { async limit() { throw new Error('synthetic dependency failure'); } };
function environment(db, overrides = {}) {
  return {
    APP_MODE: 'managed', APP_ORIGIN: origin, APP_ALLOWED_ORIGINS: `${origin},${alternate}`,
    ACCESS_TEAM_DOMAIN: 'https://sample-team.cloudflareaccess.com', ACCESS_AUDIENCE: 'a'.repeat(64), OWNER_EMAIL: 'owner@example.com',
    PUBLIC_ADMISSION_GLOBAL: allow, PUBLIC_ADMISSION_CLIENT: allow, OWNER_ADMISSION_CLIENT: allow,
    DB: db, ASSETS: { fetch() { assert.fail('No asset fallback'); } }, ...overrides,
  };
}
function request(path, { base = origin, ip = '192.0.2.1', token, cookie } = {}) {
  const post = ['/api/weather', '/api/enrollment/claim', '/api/admin/revoke', '/api/admin/pairing'].includes(path);
  return new Request(base + path, {
    method: post ? 'POST' : 'GET',
    headers: { Origin: base, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json',
      ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(post ? { body: JSON.stringify(path === '/api/weather' ? { zipCode: '00000' } : { code: 'ABCDEFGHJK' }) } : {}),
  });
}

test('public denial, missing bindings and limiter failures do zero D1 or provider work on every origin', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No provider requests'));
  for (const base of [origin, alternate]) {
    for (const path of ['/api/enrollment/claim', '/api/bootstrap', '/api/%62ootstrap', '/api/display', '/api/weather']) {
      for (const [binding, value, status] of [
        ['PUBLIC_ADMISSION_GLOBAL', deny, 429], ['PUBLIC_ADMISSION_CLIENT', deny, 429],
        ['PUBLIC_ADMISSION_GLOBAL', undefined, 503], ['PUBLIC_ADMISSION_CLIENT', undefined, 503],
        ['PUBLIC_ADMISSION_GLOBAL', unavailable, 503], ['PUBLIC_ADMISSION_CLIENT', unavailable, 503],
      ]) {
        const db = { prepare() { assert.fail('Denied requests must not prepare D1 statements'); }, batch() { assert.fail('No D1 batch'); } };
        const response = await worker.fetch(request(path, { base, cookie: `__Host-sabio_display=${'a'.repeat(64)}` }), environment(db, { [binding]: value }));
        assert.equal(response.status, status, `${base}${path} ${binding}`);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        if (status === 429) assert.equal(response.headers.get('Retry-After'), '60');
      }
    }
  }
});

test('bounded canonical client keys share route groups across origins and ignore untrusted credentials', async () => {
  const db = new LocalD1();
  try {
    const aggregateKeys = [];
    const clientKeys = [];
    const env = environment(db, {
      PUBLIC_ADMISSION_GLOBAL: { async limit({ key }) { aggregateKeys.push(key); return { success: true }; } },
      PUBLIC_ADMISSION_CLIENT: { async limit({ key }) { clientKeys.push(key); return { success: true }; } },
    });
    for (const [path, base, ip] of [
      ['/api/bootstrap', origin, '2001:db8::1'], ['/api/%62ootstrap', alternate, '2001:0db8:0:0:0:0:0:1'],
      ['/api/display', origin, '2001:db8::1'], ['/api/weather', alternate, '2001:db8::1'],
    ]) await worker.fetch(request(path, { base, ip, cookie: `__Host-sabio_display=${'b'.repeat(64)}` }), env);
    assert.deepEqual(aggregateKeys, Array(4).fill('aggregate:public'));
    assert.equal(clientKeys[0], clientKeys[1]);
    assert.match(clientKeys[0], /^client:bootstrap:[a-f0-9]{64}$/);
    assert.match(clientKeys[2], /^client:display:[a-f0-9]{64}$/);
    assert.match(clientKeys[3], /^client:weather:[a-f0-9]{64}$/);
    for (const ip of ['', 'unknown', '192.0.2.1,192.0.2.2', '192.000.2.1', '1'.repeat(100), '::ffff:999.1.1.1']) {
      const before = db.stats();
      assert.equal((await worker.fetch(request('/api/bootstrap', { ip }), env)).status, 403);
      assert.deepEqual(db.stats(), before);
    }
    assert.equal(clientKeys.length, 4);
  } finally { db.close(); }
});

test('unverified owner intake never touches D1, and signature work is bounded before verification', async (t) => {
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { providerCalls++; return Response.json({ keys: [] }); });
  const db = { prepare() { assert.fail('Unverified owner must not prepare D1 statements'); }, batch() { assert.fail('No D1 batch'); } };
  for (const path of ['/admin', '/api/admin/displays', '/api/admin/pairing', '/api/admin/revoke']) {
    for (const [value, status] of [[deny, 429], [undefined, 503], [unavailable, 503]]) {
      assert.equal((await worker.fetch(request(path, { token: 'e30.e30.AAAA' }), environment(db, { OWNER_ADMISSION_CLIENT: value }))).status, status);
    }
    assert.equal((await worker.fetch(request(path), environment(db))).status, 401);
    assert.equal((await worker.fetch(request(path, { token: 'x'.repeat(8193) }), environment(db))).status, 401);
  }
  assert.equal(providerCalls, 0);
  // A bounded, syntactically shaped invalid JWT reaches the synthetic verifier,
  // but still cannot consume owner D1 counters or cleanup.
  assert.equal((await worker.fetch(request('/api/admin/displays', { token: 'eyJhbGciOiJSUzI1NiJ9.e30.AAAA' }), environment(db))).status, 401);
  assert.ok(providerCalls <= 1);
  assert.equal((await handleAccessRequest(request('/api/admin/displays'), db, async () => false, origin)).status, 401);
});

test('client denials preserve aggregate public capacity and owner verification has no cross-client bucket', async () => {
  const keys = [];
  const db = { prepare() { assert.fail('No D1 work'); } };
  const publicEnv = environment(db, {
    PUBLIC_ADMISSION_CLIENT: deny,
    PUBLIC_ADMISSION_GLOBAL: { async limit() { assert.fail('Client denial must not spend aggregate capacity'); } },
  });
  assert.equal((await worker.fetch(request('/api/bootstrap'), publicEnv)).status, 429);
  const ownerEnv = environment(db, {
    OWNER_ADMISSION_CLIENT: { async limit({ key }) { keys.push(key); return { success: false }; } },
  });
  for (const [path, base, ip] of [
    ['/api/admin/displays', origin, '192.0.2.1'],
    ['/api/admin/displays', alternate, '192.0.2.1'],
    ['/api/admin/revoke', origin, '192.0.2.1'],
    ['/api/admin/revoke', origin, '192.0.2.2'],
  ]) assert.equal((await worker.fetch(request(path, { base, ip, token: 'e30.e30.AAAA' }), ownerEnv)).status, 429);
  assert.equal(keys.length, 4, 'one preliminary limiter call per owner request');
  assert.equal(keys[0], keys[1], 'owner aliases share a client/group allowance');
  assert.match(keys[0], /^client:owner:[a-f0-9]{64}$/);
  assert.match(keys[2], /^client:owner-revoke:[a-f0-9]{64}$/);
  assert.notEqual(keys[2], keys[3], 'different clients never share an unverified owner allowance');
});

test('owner admission does not require a public aggregate binding', async () => {
  const db = { prepare() { assert.fail('Unverified owner must not prepare D1 statements'); } };
  const response = await worker.fetch(request('/api/admin/displays', { token: 'e30.e30.AAAA' }), environment(db, {
    PUBLIC_ADMISSION_GLOBAL: undefined,
    OWNER_ADMISSION_CLIENT: allow,
  }));
  assert.equal(response.status, 401);
});

test('several displays can pair and poll on one shared network while strict display limits remain', async () => {
  const db = new LocalD1();
  try {
    const env = environment(db);
    for (let index = 0; index < 4; index++) {
      const pairing = await handleAccessRequest(request('/api/admin/pairing'), db, async () => true, origin);
      const { code } = await pairing.json();
      const claim = new Request(origin + '/api/enrollment/claim', {
        method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const paired = await worker.fetch(claim, env);
      assert.equal(paired.status, 200);
      const cookie = paired.headers.get('Set-Cookie').split(';')[0];
      for (let poll = 0; poll < 12; poll++) {
        const response = await worker.fetch(request('/api/bootstrap', { cookie }), env);
        assert.deepEqual(await response.json(), { mode: 'managed', enrolled: true });
      }
      assert.equal((await worker.fetch(request('/api/bootstrap', { cookie }), env)).status, 429);
    }
  } finally { db.close(); }
});
