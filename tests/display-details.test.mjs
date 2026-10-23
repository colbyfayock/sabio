import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['web/display-details.ts'], bundle: true, format: 'esm', target: 'firefox68', write: false });
const { displayDetails } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('admin descriptions display bounded browser/device labels and last weather area only', () => {
  const result = displayDetails({
    id: 'synthetic-session-id', expiresAt: 1800000000,
    name: 'Living room frame',
    device: { type: 'tablet', browser: 'Firefox 68.11.0', os: 'Android 4.4.2' },
    lastSeenAt: 1792670400,
    weatherArea: { label: 'Sample Town, Sample State', timeZone: 'America/New_York', updatedAt: 1792669800 },
  });
  assert.equal(result.title, 'Living room frame · Tablet-like · Firefox 68.11.0');
  assert.equal(result.platform, 'Android 4.4.2');
  assert.match(result.seen, /Last check-in:/);
  assert.match(result.location, /Sample Town, Sample State · America\/New_York/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-session-id|1792670400/);
});

test('missing, malformed and excessive metadata safely falls back without throwing', () => {
  assert.deepEqual(displayDetails({}), {
    title: 'Unknown device', platform: 'Operating system not reported yet',
    seen: 'Waiting for first display check-in', location: 'Last weather area: not reported yet',
  });
  const unsafe = displayDetails({
    device: { type: 'phone', browser: '<img src=x>', os: 'x'.repeat(65) },
    lastSeenAt: 'not a timestamp',
    weatherArea: { label: 'Injected\narea', timeZone: 'Bad/Zone', updatedAt: 99999999999 },
  });
  assert.equal(unsafe.title, 'Mobile / phone-like');
  assert.equal(unsafe.platform, 'Operating system not reported yet');
  assert.equal(unsafe.seen, 'Waiting for first display check-in');
  assert.equal(unsafe.location, 'Last weather area: not reported yet');
});
