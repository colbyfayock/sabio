import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/weather.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { getWeatherForZip, requestZip, boundedJson } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const timezoneModule = await build({ entryPoints: ['shared/timezone.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { isTimeZone } = await import(`data:text/javascript;base64,${Buffer.from(timezoneModule.outputFiles[0].text).toString('base64')}`);
const now = new Date('2026-10-20T12:00:00.000Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const geocode = () => ({ results: [{ name: 'Sample Town', admin1: 'Sample State', country_code: 'US', postcodes: ['00000'], latitude: 40, longitude: -75 }] });
const forecast = () => ({
  current: { time: now.getTime() / 1000 - 600, temperature_2m: 82.4, weather_code: 63 },
  current_units: { temperature_2m: '°F' },
  daily: { temperature_2m_max: [86], temperature_2m_min: [64] },
  daily_units: { temperature_2m_max: '°F', temperature_2m_min: '°F' },
  timezone: 'America/New_York',
});

function providers() {
  const calls = [];
  const api = {
    calls, geo: geocode(), weather: forecast(),
    async fetcher(input, options) {
      const url = new URL(input);
      calls.push({ url, options });
      if (url.origin === 'https://geocoding-api.open-meteo.com') return json(api.geo);
      if (url.origin === 'https://api.open-meteo.com') return json(api.weather);
      throw new Error('Unexpected provider origin');
    },
  };
  return api;
}

const dependencies = (api, extra = {}) => ({ fetcher: api.fetcher, now, ...extra });
const error = (status, code) => (value) => value.status === status && (!code || value.code === code);

test('IANA timezone validation accepts DST-sensitive zones and rejects unbounded or injected values', () => {
  assert.equal(isTimeZone('America/New_York'), true);
  for (const timeZone of [undefined, '', 'Not/A_Real_Time_Zone', 'America/New_York\n', '../Etc/GMT+5', 'x'.repeat(65)]) {
    assert.equal(isTimeZone(timeZone), false);
  }
});

test('exact US ZIP lookup returns validated Fahrenheit weather without exposing coordinates', async () => {
  const api = providers();
  const data = await getWeatherForZip('00000', dependencies(api));
  assert.equal(data.unit, 'fahrenheit');
  assert.equal(data.mode, 'live');
  assert.equal(data.timeZone, 'America/New_York');
  assert.equal(data.temperatureFahrenheit, 82.4);
  assert.equal(data.highFahrenheit, 86);
  assert.equal(data.lowFahrenheit, 64);
  assert.equal(data.condition, 'Rain');
  assert.equal(data.locationLabel, 'Sample Town, Sample State');
  assert.equal(data.latitude, undefined);
  assert.equal(data.longitude, undefined);
  assert.equal(data.zipCode, undefined);
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[0].url.searchParams.get('name'), '00000');
  assert.equal(api.calls[0].url.searchParams.get('countryCode'), 'US');
  assert.equal(api.calls[1].url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(api.calls[1].url.searchParams.get('forecast_days'), '1');
  assert.equal(api.calls[1].url.searchParams.get('timezone'), 'auto');
  for (const { options } of api.calls) {
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
  }
});

test('weather service rejects malformed ZIPs and ZIP+4 before any upstream request', async () => {
  const api = providers();
  for (const zip of ['0000', '00000-0000', '00000\n', '１２３４５', 12345]) {
    await assert.rejects(getWeatherForZip(zip, dependencies(api)), error(400, 'invalid_zip'));
  }
  assert.equal(api.calls.length, 0);
});

test('fuzzy, non-US and absent postcode matches never become a forecast', async () => {
  for (const mutate of [
    (api) => { api.geo = {}; },
    (api) => { api.geo.results[0].country_code = 'CA'; },
    (api) => { api.geo.results[0].postcodes = ['11111']; },
    (api) => { delete api.geo.results[0].postcodes; },
  ]) {
    const api = providers();
    mutate(api);
    await assert.rejects(getWeatherForZip('00000', dependencies(api)), error(404, 'zip_not_found'));
    assert.equal(api.calls.length, 1);
  }
});

test('geocoding rejects invalid coordinates and malformed provider records', async () => {
  for (const mutate of [
    (api) => { api.geo.results[0].latitude = 91; },
    (api) => { api.geo.results[0].longitude = '0'; },
    (api) => { api.geo.results[0].name = ''; },
    (api) => { api.geo = { results: 'bad' }; },
  ]) {
    const api = providers();
    mutate(api);
    await assert.rejects(getWeatherForZip('00000', dependencies(api)), error(502, 'weather_unavailable'));
  }
});

test('Celsius, null, inverted highs/lows, stale times and malformed forecasts fail closed', async () => {
  for (const mutate of [
    (api) => { api.weather.current_units.temperature_2m = '°C'; },
    (api) => { api.weather.daily_units.temperature_2m_min = '°C'; },
    (api) => { api.weather.current.temperature_2m = null; },
    (api) => { api.weather.daily.temperature_2m_max = [50]; },
    (api) => { api.weather.current.time -= 4 * 3600; },
    (api) => { api.weather.current.time += 2 * 3600; },
    (api) => { api.weather.current.weather_code = null; },
    (api) => { api.weather.daily = null; },
    (api) => { delete api.weather.timezone; },
    (api) => { api.weather.timezone = 'Not/A_Real_Time_Zone'; },
    (api) => { api.weather.timezone = 'America/New_York\n'; },
    (api) => { api.weather.timezone = 'x'.repeat(65); },
  ]) {
    const api = providers();
    mutate(api);
    await assert.rejects(getWeatherForZip('00000', dependencies(api)), error(502, 'weather_unavailable'));
  }
});

test('unknown condition codes do not fabricate sunny weather', async () => {
  const api = providers();
  api.weather.current.weather_code = 999;
  assert.equal((await getWeatherForZip('00000', dependencies(api))).condition, 'Conditions unavailable');
});

test('upstream rate limits and transport failures return only generic safe codes', async () => {
  await assert.rejects(getWeatherForZip('00000', { now, fetcher: async () => json({ reason: 'Do not expose provider details' }, 429) }), error(429, 'provider_busy'));
  await assert.rejects(getWeatherForZip('00000', { now, fetcher: async () => { throw new Error('Never reflect provider URL or location'); } }), error(502, 'weather_unavailable'));
  await assert.rejects(getWeatherForZip('00000', { now, fetcher: async () => new Response('<html>bad</html>', { headers: { 'Content-Type': 'text/html' } }) }), error(502));
});

test('provider redirects are rejected rather than followed to another host', async () => {
  let calls = 0;
  await assert.rejects(getWeatherForZip('00000', { now, fetcher: async (_url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example.com/' } });
  } }), error(502, 'weather_unavailable'));
  assert.equal(calls, 1);
});

test('a stalled provider request is aborted with a bounded timeout', { timeout: 8000 }, async () => {
  let aborted = false;
  const fetcher = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); });
  });
  await assert.rejects(getWeatherForZip('00000', { now, fetcher }), error(504, 'weather_timeout'));
  assert.equal(aborted, true);
});

test('public weather cache keys omit raw ZIPs and expire independently of other areas', async () => {
  const api = providers();
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(request.url)?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
  const first = await getWeatherForZip('00000', dependencies(api, { cache }));
  const second = await getWeatherForZip('00000', dependencies(api, { cache }));
  assert.deepEqual(second, first);
  assert.equal(api.calls.length, 2);
  assert.equal(entries.size, 1);
  const [key, response] = [...entries][0];
  assert.ok(!key.includes('00000'));
  assert.match(key, /\/.weather-cache\/v2\//);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=600');
  api.geo.results[0].postcodes = ['11111'];
  await getWeatherForZip('11111', dependencies(api, { cache }));
  assert.equal(entries.size, 2);
  const later = new Date(now.getTime() + 601000);
  api.geo.results[0].postcodes = ['00000'];
  await getWeatherForZip('00000', dependencies(api, { cache, now: later }));
  assert.equal(api.calls.length, 6);
});

test('cache failures never prevent a valid forecast or reflect cache exceptions', async () => {
  const api = providers();
  const cache = { async match() { throw new Error('Private details'); }, async put() { throw new Error('Private details'); } };
  assert.equal((await getWeatherForZip('00000', dependencies(api, { cache }))).unit, 'fahrenheit');
});

test('cache entries with unexpected fields cannot expose extra location data', async () => {
  const api = providers();
  const valid = await getWeatherForZip('00000', dependencies(api));
  api.calls.length = 0;
  const cache = { async match() { return json({ ...valid, latitude: 40 }); }, async put() {} };
  const result = await getWeatherForZip('00000', dependencies(api, { cache }));
  assert.equal(api.calls.length, 2);
  assert.equal(result.latitude, undefined);
});

test('legacy and invalid-timezone cache payloads are rejected and refreshed', async () => {
  const api = providers();
  const legacy = await getWeatherForZip('00000', dependencies(api));
  const malformed = { ...legacy, timeZone: 'America/New_York\n' };
  api.calls.length = 0;

  for (const cached of [
    Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== 'timeZone')),
    malformed,
  ]) {
    const cache = { async match() { return json(cached); }, async put() {} };
    const refreshed = await getWeatherForZip('00000', dependencies(api, { cache }));
    assert.equal(refreshed.timeZone, 'America/New_York');
    assert.equal(api.calls.length, 2);
    api.calls.length = 0;
  }
});

test('weather body accepts only a small ZIP5 JSON object without extra provider options', async () => {
  const request = (body, type = 'application/json') => new Request('https://example.com/api/weather', { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.equal(await requestZip(request('{"zipCode":"00000"}')), '00000');
  for (const body of ['{}', '{"zipCode":12345}', '{"zipCode":"00000","url":"https://example.com"}', 'x'.repeat(257), '{not json']) {
    await assert.rejects(requestZip(request(body)), error(400));
  }
  await assert.rejects(requestZip(request('{"zipCode":"00000-0000"}')), error(400, 'invalid_zip'));
  await assert.rejects(requestZip(request('zipCode=00000', 'application/x-www-form-urlencoded')), error(415));
  await assert.rejects(requestZip(request('{}', 'application/json-extra')), error(415));
});

test('unadvertised oversized streams are cancelled before JSON parsing', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(boundedJson(response, 32));
  assert.equal(cancelled, true);
  await assert.rejects(boundedJson(new Response('small', { headers: { 'Content-Length': '1000' } }), 32));
});
