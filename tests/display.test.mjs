import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/app.ts'], bundle: true, format: 'iife', target: 'firefox68', write: false,
});
const source = compiled.outputFiles[0].text;
const fixture = () => ({
  mode: 'live', unit: 'fahrenheit', locationLabel: 'Sample Town', timeZone: 'America/New_York',
  temperatureFahrenheit: 68, highFahrenheit: 72, lowFahrenheit: 54,
  condition: 'Cloudy', observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
});

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.checked = false;
    this.hidden = false;
    this.value = '';
  }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  fire(name, event = { preventDefault() {} }) { for (const callback of this.listeners.get(name) || []) callback(event); }
  dispatchEvent(event) { this.fire(event.type, event); return true; }
}

function browser() {
  const ids = new Map();
  const element = (id) => {
    if (!ids.has(id)) {
      const node = new Element();
      node.focus = () => { document.activeElement = node; };
      ids.set(id, node);
    }
    return ids.get(id);
  };
  const status = new Element();
  const shell = new Element();
  const document = new Element();
  document.getElementById = element;
  document.querySelector = (selector) => selector === '.connection-status' ? status : selector === '.page-shell' ? shell : null;
  document.createElement = () => new Element();
  document.documentElement = new Element();
  element('location-dialog').hidden = true;
  element('access-dialog').hidden = true;
  element('display-options').hidden = true;
  element('display-options-toggle').setAttribute('aria-expanded', 'false');
  element('location-dialog').children = ['location-input', 'location-form', 'location-save', 'location-cancel', 'location-reset'].map(element);
  shell.querySelectorAll = () => ['display-options-toggle', 'location-open', 'fullscreen-toggle', 'weather-refresh'].map(element);
  const window = new Element();
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => ++nextTimer;
  const navigator = { onLine: true };
  const calls = [];
  const instance = {
    element, status, shell, document, window, navigator, timers, calls,
    respond: async (url) => new Response(JSON.stringify(url === '/api/bootstrap' ? { mode: 'preview' } : fixture())),
    start() {
      vm.runInNewContext(source, {
        document, window, navigator, AbortController, URL, Event,
        fetch: (...args) => { calls.push(args); return instance.respond(...args); },
      });
    },
    async settle() { await new Promise(setImmediate); },
    async runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
      await this.settle();
    },
    hasTimer(delay) { return [...timers.values()].some((timer) => timer.delay === delay); },
  };
  return instance;
}

test('Horizon checks bootstrap, starts a clock and photos, but never polls demo or weather without a ZIP', async () => {
  const page = browser();
  page.start();
  await page.settle();
  assert.equal(page.element('temperature').textContent, '—°F');
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0][0], '/api/bootstrap');
  assert.notEqual(page.element('clock').textContent, '');
  assert.match(page.element('photoA').src, /^https:\/\/images.unsplash.com\//);
  assert.equal(page.hasTimer(60000), false);
});

test('display options are opened from the Sabio wordmark and contain ZIP, weather and fullscreen actions', async () => {
  const html = await readFile('web/index.html', 'utf8');
  assert.match(html, /<title>Sabio<\/title>/);
  assert.doesNotMatch(html, /display-mode|class="folio"|>Horizon</);
  assert.doesNotMatch(html, /class="eyebrow">Local time|id="themeMode"|id="appearance-status"|>Appearance</);
  assert.match(html, /id="display-options-toggle"[^>]*aria-controls="display-options"/);
  assert.match(html, /id="display-options"[^>]*hidden/);
  assert.match(html, /id="fullscreen-toggle"[\s\S]*id="fullscreen-label">Enter fullscreen/);
  assert.match(html, /id="location-open"/);
  assert.match(html, /id="weather-refresh"[\s\S]*id="weather-status"/);
  assert.doesNotMatch(html, /id="photo-open"|id="photo-dialog"/);
  assert.doesNotMatch(html, /class="weather-label"|>Weather</);
  assert.ok(html.indexOf('id="weather-status"') < html.indexOf('class="options-attribution"'));
  assert.doesNotMatch(html, /id="weather-resolved"/);
});

test('Sabio options open by tapping the wordmark and close on Escape or outside click', async () => {
  const page = browser();
  page.start();
  await page.settle();
  const panel = page.element('display-options');
  const toggle = page.element('display-options-toggle');
  toggle.fire('click');
  assert.equal(panel.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  page.document.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(panel.hidden, true);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  toggle.fire('click');
  page.document.fire('click', { target: page.element('temperature') });
  assert.equal(panel.hidden, true);
});

test('fullscreen reflects actual browser events and exposes a rejection', async () => {
  const page = browser();
  page.document.documentElement.requestFullscreen = async () => {
    page.document.fullscreenElement = page.document.documentElement;
    page.document.fire('fullscreenchange');
  };
  page.document.exitFullscreen = async () => {
    page.document.fullscreenElement = null;
    page.document.fire('fullscreenchange');
  };
  page.start();
  await page.settle();
  page.element('fullscreen-toggle').fire('click');
  await page.settle();
  assert.equal(page.element('fullscreen-toggle').attributes['aria-pressed'], 'true');
  assert.equal(page.element('fullscreen-toggle').attributes['aria-label'], 'Exit fullscreen');
  assert.equal(page.element('fullscreen-label').textContent, 'Exit fullscreen');
  page.element('fullscreen-toggle').fire('click');
  await page.settle();
  assert.equal(page.element('fullscreen-toggle').attributes['aria-label'], 'Enter fullscreen');
  assert.equal(page.element('fullscreen-label').textContent, 'Enter fullscreen');
  page.document.documentElement.requestFullscreen = async () => { throw new Error('Denied'); };
  page.element('fullscreen-toggle').fire('click');
  await page.settle();
  assert.match(page.element('fullscreen-message').textContent, /isn’t available/);
});

test('prefixed Firefox fullscreen fallback follows actual state without a Promise', async () => {
  const page = browser();
  page.document.documentElement.mozRequestFullScreen = () => {
    page.document.mozFullScreenElement = page.document.documentElement;
    page.document.fire('mozfullscreenchange');
  };
  page.document.mozCancelFullScreen = () => {
    page.document.mozFullScreenElement = null;
    page.document.fire('mozfullscreenchange');
  };
  page.start();
  await page.settle();
  page.element('fullscreen-toggle').fire('click');
  assert.equal(page.element('fullscreen-toggle').attributes['aria-pressed'], 'true');
  assert.equal(page.element('fullscreen-toggle').attributes['aria-label'], 'Exit fullscreen');
  page.element('fullscreen-toggle').fire('click');
  assert.equal(page.element('fullscreen-toggle').attributes['aria-label'], 'Enter fullscreen');
  assert.equal(page.element('fullscreen-label').textContent, 'Enter fullscreen');
});

function locationStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

test('ZIP preference survives reload, starts weather lookup, and rejects markup as a ZIP', async () => {
  const storage = locationStorage();
  storage.setItem('sabio.location.v1', JSON.stringify({ version: 2, zipCode: '00000' }));
  const page = browser();
  page.window.localStorage = storage;
  page.start();
  await page.settle();
  const requestCount = page.calls.length;
  page.element('location-open').fire('click');
  assert.equal(page.document.activeElement, page.element('location-input'));
  assert.equal(page.element('location-input').value, '00000');
  page.element('location-input').value = ' <img src=x onerror=alert(1)> ';
  page.element('location-form').fire('submit');
  assert.equal(page.element('location-dialog').hidden, false);
  assert.equal(page.element('location-error').hidden, false);
  assert.equal(page.element('weather-location').textContent, 'ZIP 00000');
  assert.equal(JSON.parse(storage.getItem('sabio.location.v1')).zipCode, '00000');
  assert.equal(page.element('weather-location').children.length, 0);
  page.element('location-input').value = ' 00000-0000 ';
  page.element('location-form').fire('submit');
  assert.equal(page.element('weather-location').textContent, 'ZIP 00000-0000');
  assert.equal(page.element('weather-location').children.length, 0);
  assert.equal(page.element('location-dialog').hidden, true);
  assert.equal(page.document.activeElement, page.element('location-open'));
  assert.equal(page.calls.length, requestCount + 1);
  await page.settle();
  assert.equal(page.hasTimer(600000), true);
  assert.equal(page.element('time-zone').textContent, 'America/New York');
  assert.equal(page.element('weather-location').textContent, 'ZIP 00000-0000');

  const reload = browser();
  reload.window.localStorage = storage;
  reload.respond = async (url) => url === '/api/bootstrap' ? Response.json({ mode: 'preview' }) : new Response('{}', { status: 503 });
  reload.start();
  await reload.settle();
  assert.equal(reload.element('weather-location').textContent, 'ZIP 00000-0000');
});

test('location dialog validates, traps focus, and cancels without changing saved data', async () => {
  const page = browser();
  const storage = locationStorage();
  storage.setItem('sabio.location.v1', JSON.stringify({ version: 2, zipCode: '00000' }));
  page.window.localStorage = storage;
  page.start();
  await page.settle();
  page.shell.setAttribute('aria-hidden', 'false');
  page.element('location-open').setAttribute('tabindex', '0');
  page.element('location-open').fire('click');
  assert.equal(page.shell.getAttribute('aria-hidden'), 'true');
  assert.equal(page.element('location-open').getAttribute('tabindex'), '-1');
  page.document.fire('focusin', { target: page.element('retry-button') });
  assert.equal(page.document.activeElement, page.element('location-input'));
  page.element('location-input').value = ' ';
  page.element('location-form').fire('submit');
  assert.equal(page.element('location-dialog').hidden, false);
  assert.equal(page.element('location-error').hidden, false);
  page.element('location-dialog').fire('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(page.document.activeElement, page.element('location-save'));
  page.element('location-dialog').fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(page.document.activeElement, page.element('location-input'));
  page.element('location-input').value = 'Not saved';
  page.element('location-dialog').fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(page.element('location-dialog').hidden, true);
  assert.equal(page.shell.getAttribute('aria-hidden'), 'false');
  assert.equal(page.element('location-open').getAttribute('tabindex'), '0');
  assert.equal(page.element('fullscreen-toggle').getAttribute('tabindex'), null);
  assert.equal(JSON.parse(storage.getItem('sabio.location.v1')).zipCode, '00000');
  page.element('location-open').fire('click');
  page.element('location-input').value = 'Still not saved';
  page.element('location-cancel').fire('click');
  assert.equal(page.element('weather-location').textContent, 'ZIP 00000');
});

test('legacy preference is not used and can be explicitly reset', async () => {
  const page = browser();
  const storage = locationStorage();
  const legacy = JSON.stringify({ version: 1, label: 'Sample City' });
  storage.setItem('sabio.location.v1', legacy);
  page.window.localStorage = storage;
  page.start();
  await page.settle();
  assert.equal(page.element('weather-location').textContent, 'Weather location');
  assert.match(page.element('location-status').textContent, /preferences that are not ZIP codes are not used/);
  assert.equal(storage.getItem('sabio.location.v1'), legacy);
  page.element('location-open').fire('click');
  assert.equal(page.element('location-reset').hidden, false);
  page.element('location-cancel').fire('click');
  assert.equal(storage.getItem('sabio.location.v1'), legacy);
  page.element('location-open').fire('click');
  page.element('location-reset').fire('click');
  assert.equal(storage.getItem('sabio.location.v1'), null);
  assert.equal(page.element('weather-location').textContent, 'Weather location');
});

test('a failed reset keeps the reset control available for a newly saved ZIP', async () => {
  const page = browser();
  const storage = locationStorage();
  storage.removeItem = () => { throw new Error('Storage unavailable'); };
  page.window.localStorage = storage;
  page.start();
  await page.settle();
  page.element('location-open').fire('click');
  page.element('location-input').value = '00000';
  page.element('location-form').fire('submit');
  page.element('location-open').fire('click');
  page.element('location-reset').fire('click');
  assert.equal(page.element('location-reset').hidden, false);
  assert.equal(JSON.parse(storage.getItem('sabio.location.v1')).zipCode, '00000');
  assert.match(page.element('location-status').textContent, /could not be cleared/);
});

test('reset removes only the location key and blocked persistence keeps a visible visit-only choice', async () => {
  const page = browser();
  const storage = locationStorage();
  storage.setItem('sabio.location.v1', JSON.stringify({ version: 2, zipCode: '00000' }));
  storage.setItem('unrelated.test.key', 'untouched');
  page.window.localStorage = storage;
  page.start();
  await page.settle();
  page.element('location-open').fire('click');
  page.element('location-reset').fire('click');
  assert.equal(storage.getItem('sabio.location.v1'), null);
  assert.equal(storage.getItem('unrelated.test.key'), 'untouched');
  assert.equal(page.element('weather-location').textContent, 'Weather location');

  const blocked = browser();
  Object.defineProperty(blocked.window, 'localStorage', { get() { throw new Error('Blocked'); } });
  blocked.start();
  await blocked.settle();
  blocked.element('location-open').fire('click');
  blocked.element('location-input').value = '00000';
  blocked.element('location-form').fire('submit');
  assert.equal(blocked.element('weather-location').textContent, 'ZIP 00000');
  assert.match(blocked.element('location-status').textContent, /visit only/);
});
