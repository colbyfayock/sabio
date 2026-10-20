import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  write: false,
});
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

function assets() {
  const requests = [];
  return {
    requests,
    env: {
      ASSETS: {
        async fetch(request) {
          requests.push(request);
          return new Response('<!doctype html><title>Mock asset</title>', {
            headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=600' },
          });
        },
      },
    },
  };
}

test('public demo is explicitly synthetic and does not require credentials', async () => {
  const { env, requests } = assets();
  const response = await worker.fetch(new Request('https://example.com/api/demo'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mode, 'demo');
  assert.equal(data.weather.locationLabel, 'Sample weather');
  assert.equal(data.events.length, 3);
  assert.equal(data.tasks.length, 3);
  assert.ok(Number.isFinite(Date.parse(data.updatedAt)));
  assert.equal(requests.length, 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('fixtures do not share mutable objects across responses', async () => {
  const { env } = assets();
  const first = await (await worker.fetch(new Request('https://example.com/api/demo'), env)).json();
  first.tasks[0].title = 'Changed by a caller';
  const second = await (await worker.fetch(new Request('https://example.com/api/demo'), env)).json();
  assert.equal(second.tasks[0].title, 'Water the plants');
});

test('private display data is denied on any host regardless of claimed identity', async () => {
  const { env, requests } = assets();
  for (const host of ['example.com', 'preview.example.com']) {
    for (const path of ['/api/display', '/api/display/agenda', '/%61pi/display', '/api%2fdisplay', '/api/display?approved=true']) {
      const response = await worker.fetch(new Request(`https://${host}${path}`, {
        headers: { Cookie: 'sabio=synthetic-test-value', 'Cf-Access-Authenticated-User-Email': 'not-an-admin@example.com' },
      }), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
      assert.equal((await response.json()).error, 'display_access_unavailable');
    }
  }
  assert.equal(requests.length, 0);
});

test('enrollment and admin endpoints never pretend successful authentication', async () => {
  const { env, requests } = assets();
  for (const path of ['/api/enrollment', '/api/enrollment/approve', '/api/admin', '/admin', '/auth/callback']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`, { method }), env);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'not_implemented');
      assert.equal(response.headers.get('Set-Cookie'), null);
    }
  }
  assert.equal(requests.length, 0);
});

test('unknown APIs and files do not fall through to HTML or an asset binding', async () => {
  const { env, requests } = assets();
  for (const path of ['/api', '/api/unknown', '/.env', '/worker-configuration.d.ts', '/src/index.ts', '/anything']) {
    const response = await worker.fetch(new Request(`https://example.com${path}`), env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'not_found');
  }
  assert.equal(requests.length, 0);
});

test('malformed URL encoding is rejected before asset routing', async () => {
  const { env, requests } = assets();
  const response = await worker.fetch(new Request('https://example.com/%E0%A4%A'), env);
  assert.equal(response.status, 400);
  assert.equal(requests.length, 0);
});

test('public routes reject mutation and preflight without inventing permissive CORS', async () => {
  const { env, requests } = assets();
  for (const path of ['/', '/app.js', '/api/demo', '/health']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`, { method }), env);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('Allow'), 'GET, HEAD');
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
  assert.equal(requests.length, 0);
});

test('static responses get same-origin security policy without caching personal state', async () => {
  const { env, requests } = assets();
  const response = await worker.fetch(new Request('https://example.com/'), env);
  assert.equal(requests.length, 1);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const policy = response.headers.get('Content-Security-Policy');
  assert.ok(policy.includes("connect-src 'self'"));
  assert.ok(policy.includes("script-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(!policy.includes('unsafe-inline'));
});

test('HEAD returns headers without data or asset response bodies', async () => {
  const { env } = assets();
  for (const [path, status] of [['/', 200], ['/api/demo', 200], ['/health', 200], ['/api/display', 401], ['/admin', 503]]) {
    const response = await worker.fetch(new Request(`https://example.com${path}`, { method: 'HEAD' }), env);
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
  }
});

test('asset binding failure is closed without reflecting exception details', async () => {
  const original = console.error;
  const logs = [];
  console.error = (message) => logs.push(message);
  try {
    const response = await worker.fetch(new Request('https://example.com/?input=synthetic'), {
      ASSETS: { fetch() { throw new Error('Do not expose runtime exception contents'); } },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
    assert.deepEqual(logs.map((message) => JSON.parse(message)), [{ event: 'asset_fetch_failed' }]);
  } finally {
    console.error = original;
  }
});
