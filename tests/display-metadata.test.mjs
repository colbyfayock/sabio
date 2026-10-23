import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/display-metadata.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { describeBrowser, recordDisplayCheckIn, recordDisplayWeatherArea } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('browser descriptions classify only bounded coarse labels and never retain raw user agents', () => {
  assert.deepEqual(describeBrowser('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'), {
    type: 'desktop', browser: 'Chrome 124.0', os: 'Linux',
  });
  assert.deepEqual(describeBrowser('Mozilla/5.0 (Linux; Android 9; Kiosk) AppleWebKit/537.36 Chrome/98.0 Mobile Safari/537.36'), {
    type: 'phone', browser: 'Chrome 98.0', os: 'Android 9',
  });
  assert.deepEqual(describeBrowser('Mozilla/5.0 (Linux; Android 12; Tablet) AppleWebKit/537.36 Chrome/100.0 Safari/537.36'), {
    type: 'tablet', browser: 'Chrome 100.0', os: 'Android 12',
  });
  assert.deepEqual(describeBrowser(null), { type: 'unknown', browser: null, os: null });
  assert.deepEqual(describeBrowser('synthetic\u0000value'), { type: 'unknown', browser: null, os: null });
  assert.deepEqual(describeBrowser('x'.repeat(513)), { type: 'unknown', browser: null, os: null });
});

test('check-ins are throttled and write no IP, raw user-agent, model, or URL fields', async () => {
  const calls = [];
  const db = { prepare(query) { return { bind(...values) { calls.push({ query, values }); return { async run() {} }; } }; } };
  const now = Date.parse('2026-10-22T12:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await recordDisplayCheckIn(new Request('https://sabio.example/api/bootstrap', { headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36',
    } }), db, 'display-id');
  } finally { Date.now = realNow; }
  assert.match(calls[0].query, /device_type = CASE WHEN \? = 'unknown' THEN device_type ELSE \? END/);
  assert.match(calls[0].query, /browser_label = COALESCE\(\?, browser_label\)/);
  assert.doesNotMatch(calls[0].query, /user_agent|ip_address|serial|model|url/i);
  assert.deepEqual(calls[0].values, ['desktop', 'desktop', 'Chrome 124.0', 'Linux', now / 1000, 'display-id', now / 1000, now / 1000 - 300]);
});

test('last weather area validates label/timezone, rejects provider control chars, and never writes ZIP or coordinates', async () => {
  const calls = [];
  const db = { prepare(query) { return { bind(...values) { calls.push({ query, values }); return { async run() {} }; } }; } };
  const now = Date.parse('2026-10-22T12:00:00Z');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await recordDisplayWeatherArea(db, 'display-id', 'Sample Town, Sample State', 'America/Los_Angeles');
    await recordDisplayWeatherArea(db, 'display-id', 'Bad\nLabel', 'America/Los_Angeles');
    await recordDisplayWeatherArea(db, 'display-id', 'Sample Town', 'Not/A_Timezone');
    await recordDisplayWeatherArea(db, 'display-id', 'x'.repeat(161), 'America/Los_Angeles');
  } finally { Date.now = realNow; }
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /weather_location = \?, weather_time_zone = \?, weather_location_at = \?/);
  assert.doesNotMatch(calls[0].query, /zip|latitude|longitude|coordinate|ip_address/i);
  assert.deepEqual(calls[0].values, ['Sample Town, Sample State', 'America/Los_Angeles', now / 1000, 'display-id', now / 1000, 'Sample Town, Sample State', 'America/Los_Angeles', now / 1000 - 600]);
});
