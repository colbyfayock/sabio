import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { LocalD1 } from './helpers/local-d1.mjs';

const { outputFiles } = await build({
  entryPoints: ['src/access.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { getDisplaySession, handleAccessRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);
const recovery = await readFile(
  new URL('../scripts/invalidate-restored-display-credentials.sql', import.meta.url), 'utf8',
);
const origin = 'https://example.com';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function claim(db, code) {
  return handleAccessRequest(new Request(`${origin}/api/enrollment/claim`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
    body: JSON.stringify({ code }),
  }), db, async () => false, origin);
}

test('recovery invalidates restored credentials and preserves existing revocations', async (t) => {
  const db = new LocalD1();
  t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000);
  const insertEnrollment = db.sqlite.prepare(`INSERT INTO access_enrollments
    (id, display_id, code_hash, pending_hash, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertDisplay = db.sqlite.prepare(`INSERT INTO access_displays
    (id, enrollment_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`);
  const insertSession = db.sqlite.prepare(`INSERT INTO access_display_sessions
    (token_hash, display_id, issued_at, expires_at) VALUES (?, ?, ?, ?)`);
  const revokedAt = now - 5;
  const sessions = [null, revokedAt].map((revocation) => {
    const id = randomUUID();
    const enrollment = randomUUID();
    const token = randomBytes(32).toString('hex');
    insertEnrollment.run(enrollment, id, null, null, now - 60, now + 60, 'consumed');
    insertDisplay.run(id, enrollment, now - 60, now + 600, revocation);
    insertSession.run(hash(`session:${token}`), id, now - 60, now + 600);
    return { id, token };
  });
  const oldCode = 'ABCDEFGHJK';
  insertEnrollment.run(randomUUID(), randomUUID(), hash(`pairing:${oldCode}`), null, now, now + 600, 'pending');
  insertEnrollment.run(randomUUID(), randomUUID(), null, hash('legacy-pending'), now, now + 600, 'approved');

  db.sqlite.exec(recovery);
  db.sqlite.exec(recovery);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_display_sessions').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM access_displays WHERE revoked_at IS NULL').get().count, 0);
  assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM access_enrollments WHERE status IN ('pending', 'approved')
    AND (expires_at <> 0 OR code_hash IS NOT NULL OR pending_hash IS NOT NULL)`).get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT revoked_at FROM access_displays WHERE id = ?').get(sessions[1].id).revoked_at, revokedAt);
  for (const { token } of sessions) {
    const request = new Request(`${origin}/api/display`, { headers: { Cookie: `__Host-sabio_display=${token}` } });
    assert.equal(await getDisplaySession(request, db), null);
  }
  assert.equal((await claim(db, oldCode)).status, 401);

  const newCode = 'KJHGFEDCBA';
  insertEnrollment.run(randomUUID(), randomUUID(), hash(`pairing:${newCode}`), null, now, now + 600, 'pending');
  assert.equal((await claim(db, newCode)).status, 200);
});
