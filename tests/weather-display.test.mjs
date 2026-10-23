import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/weather.ts'], bundle: true, format: 'iife', globalName: 'WeatherModule', target: 'firefox68', write: false,
});
const source = compiled.outputFiles[0].text;

class Element {
  constructor() {
    this.textContent = '';
    this.listeners = new Map();
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name) { this.listeners.get(name)?.(); }
}

function validForecast(overrides = {}) {
  const now = new Date().toISOString();
  return {
    mode: 'live', unit: 'fahrenheit', locationLabel: 'North End', timeZone: 'America/New_York',
    temperatureFahrenheit: 68, highFahrenheit: 72, lowFahrenheit: 54,
    condition: 'Light rain', observedAt: now, fetchedAt: now, ...overrides,
  };
}

function response(payload, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => payload };
}

function browser(zipCode = null, fetcher = async () => response(validForecast())) {
  const elements = new Map();
  const timers = new Map();
  const windowListeners = new Map();
  const calls = [];
  const navigator = { onLine: true };
  let timerID = 0;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
  };
  const window = {
    setTimeout(callback, delay) {
      const id = ++timerID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    fire(name) { windowListeners.get(name)?.(); },
  };
  const context = {
    WeatherModule: undefined,
    document, window, navigator, AbortController,
    fetch: (...args) => { calls.push(args); return fetcher(...args); },
    Date, Number, JSON, Math, Error,
  };
  vm.runInNewContext(source, context);
  const controller = context.WeatherModule.initializeWeatherController(() => zipCode);
  return {
    calls, elements, timers, window, navigator, controller,
    setZip(value) { zipCode = value; controller.setZipCode(value); },
    async settle() { await new Promise(setImmediate); },
    async runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
      await this.settle();
    },
  };
}

test('weather markup identifies Fahrenheit, uses neutral iconography, and credits providers', async () => {
  const html = await readFile('web/index.html', 'utf8');
  assert.match(html, /id="temperature">—°F/);
  assert.match(html, /H —°F · L —°F/);
  assert.match(html, /aria-label="Live weather"/);
  assert.match(html, /https:\/\/open-meteo\.com\//);
  assert.match(html, /https:\/\/www\.geonames\.org\//);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /Sample forecast|Demo forecast/);
});

test('no ZIP means no request; saved ZIP+4 posts only its first five digits without query or credentials', async () => {
  const page = browser();
  assert.equal(page.calls.length, 0);
  assert.equal(page.elements.get('temperature').textContent, '—°F');
  page.setZip('00000-0000');
  await page.settle();
  assert.equal(page.calls.length, 1);
  const [url, options] = page.calls[0];
  assert.equal(url, '/api/weather');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { zipCode: '00000' });
  assert.equal(page.elements.get('temperature').textContent, '68°F');
  assert.equal(page.elements.get('condition').textContent, 'Light rain');
  assert.equal(page.elements.get('weather-range').textContent, 'H 72°F · L 54°F');
  assert.equal(page.elements.get('weather-resolved').textContent, 'North End');
  assert.match(page.elements.get('weather-status').textContent, /^Updated/);
});

test('changing or resetting ZIP clears the old display and ignores out-of-order responses', async () => {
  const pending = [];
  const page = browser('00000', () => new Promise((resolve) => pending.push(resolve)));
  page.setZip('00001');
  assert.equal(page.elements.get('temperature').textContent, '—°F');
  assert.equal(page.calls.length, 2);
  pending[0](response(validForecast({ locationLabel: 'Old ZIP', temperatureFahrenheit: 99 })));
  pending[1](response(validForecast({ locationLabel: 'New ZIP', temperatureFahrenheit: 61 })));
  await page.settle();
  assert.equal(page.elements.get('temperature').textContent, '61°F');
  assert.equal(page.elements.get('weather-resolved').textContent, 'New ZIP');

  const resetPending = [];
  const reset = browser('00002', () => new Promise((resolve) => resetPending.push(resolve)));
  reset.setZip(null);
  resetPending[0](response(validForecast({ temperatureFahrenheit: 88 })));
  await reset.settle();
  assert.equal(reset.elements.get('temperature').textContent, '—°F');
  assert.equal(reset.elements.get('weather-resolved').textContent, '');
  assert.equal(reset.calls.length, 1);
});

test('same ZIP failure keeps the last forecast and marks it stale with its fetched timestamp', async () => {
  let attempts = 0;
  const page = browser('00003', async () => {
    attempts += 1;
    return attempts === 1
      ? response(validForecast())
      : response({ error: 'weather_unavailable' }, false);
  });
  await page.settle();
  await page.runTimer(600000);
  assert.equal(page.elements.get('temperature').textContent, '68°F');
  assert.match(page.elements.get('weather-status').textContent, /Weather stale/);
  assert.match(page.elements.get('weather-status').textContent, /Showing forecast fetched .+\./);
  assert.ok(page.timers.size > 0);
});

test('weather retry does not overlap an in-flight request for the same ZIP', async () => {
  let resolveRequest;
  const page = browser('00004', () => new Promise((resolve) => { resolveRequest = resolve; }));
  page.elements.get('weather-retry').fire('click');
  assert.equal(page.calls.length, 1);
  resolveRequest(response(validForecast()));
  await page.settle();
  assert.equal(page.calls.length, 1);
});

test('bad units and invalid ranges are rejected instead of being shown as Fahrenheit', async () => {
  for (const invalid of [
    { unit: 'celsius' },
    { highFahrenheit: 50, lowFahrenheit: 60 },
    { temperatureFahrenheit: null },
  ]) {
    const page = browser('00005', async () => response(validForecast(invalid)));
    await page.settle();
    assert.equal(page.elements.get('temperature').textContent, '—°F');
    assert.match(page.elements.get('weather-status').textContent, /expected format/);
  }
});

test('provider location strings are displayed as text rather than HTML', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const page = browser('00000', async () => response(validForecast({ locationLabel: name })));
  await page.settle();
  assert.equal(page.elements.get('weather-resolved').textContent, name);
  assert.equal(page.elements.get('weather-resolved').innerHTML, undefined);
});

test('offline skips requests, online resumes, and failures use bounded exponential retry delays', async () => {
  let failures = 0;
  const page = browser(null, async () => {
    failures += 1;
    return response({ error: 'provider_busy' }, false);
  });
  page.navigator.onLine = false;
  page.setZip('00006');
  await page.settle();
  assert.equal(page.calls.length, 0);
  page.navigator.onLine = true;
  page.window.fire('online');
  await page.settle();
  assert.equal(page.calls.length, 1);
  for (const delay of [60000, 120000, 240000, 480000, 960000, 1800000, 1800000]) {
    await page.runTimer(delay);
  }
  assert.equal(failures, 8);
  assert.equal([...page.timers.values()].some((timer) => timer.delay === 1800000), true);
  page.navigator.onLine = false;
  page.window.fire('offline');
  const beforeOfflineRetry = page.calls.length;
  page.controller.refresh();
  await page.settle();
  assert.equal(page.calls.length, beforeOfflineRetry);
  page.navigator.onLine = true;
  page.window.fire('online');
  await page.settle();
  assert.equal(page.calls.length, beforeOfflineRetry + 1);
});

test('timeout aborts a request and schedules a bounded retry; offline/online events are handled', async () => {
  const pending = [];
  const page = browser(null, (_url, options) => new Promise((resolve, reject) => {
    pending.push({ resolve, signal: options.signal });
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  page.setZip('00007');
  await page.runTimer(12000);
  assert.equal(pending[0].signal.aborted, true);
  assert.match(page.elements.get('weather-status').textContent, /timed out/);
  assert.equal([...page.timers.values()].some((timer) => timer.delay === 60000), true);
  page.navigator.onLine = false;
  page.window.fire('offline');
  assert.match(page.elements.get('weather-status').textContent, /Offline/);
  const before = page.calls.length;
  page.controller.refresh();
  await page.settle();
  assert.equal(page.calls.length, before);
  page.navigator.onLine = true;
  page.window.fire('online');
  await page.settle();
  assert.equal(page.calls.length, before + 1);
});

test('responses finishing after an offline event cannot hide offline state or resume polling', async () => {
  for (const succeeds of [true, false]) {
    let resolve;
    const page = browser('00000', () => new Promise((done) => { resolve = done; }));
    page.navigator.onLine = false;
    page.window.fire('offline');
    resolve(succeeds ? response(validForecast()) : response({ error: 'weather_unavailable' }, false));
    await page.settle();
    assert.match(page.elements.get('weather-status').textContent, /Offline/);
    assert.equal(page.timers.size, 0);
    assert.equal(page.elements.get('temperature').textContent, succeeds ? '68°F' : '—°F');
  }
});
