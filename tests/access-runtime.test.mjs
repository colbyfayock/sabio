import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { getPlatformProxy } from 'wrangler';

const compiled = await build({ entryPoints: ['src/access.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { handleAccessRequest, getDisplaySession } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('actual local D1 batches allow one pairing claim and enforce revocation', { timeout: 30000 }, async () => {
  const proxy = await getPlatformProxy({
    configPath: new URL('../wrangler.jsonc', import.meta.url).pathname,
    envFiles: [], persist: false, remoteBindings: false,
  });
  try {
    const db = proxy.env.DB;
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const schema = await readFile(new URL(name, directory), 'utf8');
      await db.batch(schema.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
    }
    const origin = 'https://example.com';
    const request = (path, body, cookie) => new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const call = (path, body, cookie) => handleAccessRequest(request(path, body, cookie), db, async () => true, origin);
    const pairing = await call('/api/admin/pairing', {});
    assert.equal(pairing.status, 201);
    const { code } = await pairing.json();
    const claims = await Promise.all([call('/api/enrollment/claim', { code }), call('/api/enrollment/claim', { code })]);
    assert.deepEqual(claims.map((response) => response.status).sort(), [200, 401]);
    const completed = claims.find((response) => response.status === 200);
    const session = completed.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-sabio_display=')).split(';')[0];
    const approved = await getDisplaySession(request('/api/display', undefined, session), db);
    assert.ok(approved);
    assert.equal((await call('/api/admin/revoke', { id: approved.id })).status, 204);
    assert.equal(await getDisplaySession(request('/api/display', undefined, session), db), null);
  } finally {
    await proxy.dispose();
  }
});
