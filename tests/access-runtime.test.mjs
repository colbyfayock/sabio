import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
// Keep this disposable local fixture independent of Miniflare's metadata cache.
process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
const { getPlatformProxy } = await import('wrangler');

const compiled = await build({ entryPoints: ['src/access.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { handleAccessRequest, getDisplaySession } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('actual local D1 supports single-use pairing, session listing, revocation and recovery', { timeout: 30000 }, async () => {
  const proxy = await getPlatformProxy({
    configPath: new URL('../wrangler.jsonc', import.meta.url).pathname,
    envFiles: [], persist: false, remoteBindings: false,
  });
  try {
    const db = proxy.env.DB;
    const applySql = (sql) => db.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      await applySql(await readFile(new URL(name, directory), 'utf8'));
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
    const active = await (await call('/api/admin/displays?scope=active')).json();
    assert.equal(active.displays[0].id, approved.id);
    assert.equal(active.nextCursor, null);
    assert.equal((await call('/api/admin/revoke', { id: approved.id })).status, 204);
    assert.equal(await getDisplaySession(request('/api/display', undefined, session), db), null);
    const history = await (await call('/api/admin/displays?scope=history')).json();
    assert.equal(history.displays[0].id, approved.id);
    assert.equal(history.displays[0].revoked, true);

    const pending = await call('/api/admin/pairing', {});
    const { code: pendingCode } = await pending.json();
    const recovery = await readFile(new URL('../scripts/invalidate-restored-display-credentials.sql', import.meta.url), 'utf8');
    await applySql(recovery);
    assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM access_display_sessions').first('count'), 0);
    assert.equal((await call('/api/enrollment/claim', { code: pendingCode })).status, 401);
  } finally {
    await proxy.dispose();
  }
});
