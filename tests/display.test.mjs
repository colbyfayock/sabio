import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/app.ts'], bundle: true, format: 'iife', target: 'firefox68', write: false,
});
const source = compiled.outputFiles[0].text;
const fixture = () => ({
  mode: 'demo', updatedAt: '2026-10-20T12:00:00.000Z',
  weather: { temperatureCelsius: 24, condition: 'Mostly sunny', highCelsius: 26, lowCelsius: 18, locationLabel: 'Sample weather' },
  events: [{ id: 'one', time: '09:00', title: 'Sample event', detail: 'Not connected' }],
  tasks: [{ id: 'plants', title: 'Water the plants', completed: false }],
  note: 'Sample content only.',
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
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name, event = { preventDefault() {} }) { this.listeners.get(name)?.(event); }
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
  element('location-dialog').children = ['location-input', 'location-form', 'location-save', 'location-cancel', 'location-reset'].map(element);
  shell.querySelectorAll = () => ['location-open', 'fullscreen-toggle', 'retry-button'].map(element);
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
    respond: async () => new Response(JSON.stringify(fixture())),
    start() {
      vm.runInNewContext(source, {
        document, window, navigator, AbortController,
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

test('display fetches only public same-origin demo without credentials and starts a real clock', async () => {
  const page = browser();
  page.start();
  await page.settle();
  assert.equal(page.calls[0][0], '/api/demo');
  assert.equal(page.calls[0][1].credentials, 'omit');
  assert.equal(page.element('temperature').textContent, '24°C');
  assert.notEqual(page.element('clock').textContent, '');
  assert.equal(page.status.dataset.state, 'updated');
  assert.equal(page.hasTimer(60000), true);
});

test('checklist changes survive data refresh for this visit only', async () => {
  const page = browser();
  page.start();
  await page.settle();
  const checkbox = page.element('task-list').children[0].children[0];
  checkbox.checked = true;
  checkbox.fire('change');
  await page.runTimer(60000);
  assert.equal(page.element('task-list').children[0].children[0].checked, true);
  const anotherVisit = browser();
  anotherVisit.start();
  await anotherVisit.settle();
  assert.equal(anotherVisit.element('task-list').children[0].children[0].checked, false);
});

test('untrusted data is text, never inserted as markup', async () => {
  const page = browser();
  const data = fixture();
  data.events[0].title = '<img src=x onerror=alert(1)>';
  page.respond = async () => new Response(JSON.stringify(data));
  page.start();
  await page.settle();
  const title = page.element('event-list').children[0].children[1].children[0];
  assert.equal(title.textContent, data.events[0].title);
  assert.equal(title.children.length, 0);
});

test('failed refresh retains prior data and bounds exponential backoff', async () => {
  const page = browser();
  page.start();
  await page.settle();
  page.respond = async () => new Response('{}', { status: 503 });
  for (const delay of [60000, 60000, 120000, 240000, 300000, 300000]) await page.runTimer(delay);
  assert.equal(page.element('temperature').textContent, '24°C');
  assert.equal(page.status.dataset.state, 'stale');
  assert.equal(page.hasTimer(300000), true);
});

test('invalid data is rejected without clearing the last good display', async () => {
  const page = browser();
  page.start();
  await page.settle();
  for (const mutate of [
    (data) => { data.mode = 'private'; },
    (data) => { data.tasks.push({ ...data.tasks[0] }); },
    (data) => { data.weather.temperatureCelsius = 'warm'; },
    (data) => { data.updatedAt = 'not a date'; },
    (data) => { data.events = Array(9).fill(data.events[0]); },
  ]) {
    const data = fixture();
    mutate(data);
    page.respond = async () => new Response(JSON.stringify(data));
    page.element('retry-button').fire('click');
    await page.settle();
    assert.equal(page.status.dataset.state, 'stale');
    assert.equal(page.element('temperature').textContent, '24°C');
  }
});

test('offline status suppresses requests and online event resumes polling', async () => {
  const page = browser();
  page.navigator.onLine = false;
  page.start();
  await page.settle();
  assert.equal(page.calls.length, 0);
  assert.equal(page.status.dataset.state, 'offline');
  page.navigator.onLine = true;
  page.window.fire('online');
  await page.settle();
  assert.equal(page.calls.length, 1);
  assert.equal(page.status.dataset.state, 'updated');
});

test('retry does not overlap requests and timed-out requests recover visibly', async () => {
  const page = browser();
  page.respond = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Timed out')));
  });
  page.start();
  page.element('retry-button').fire('click');
  assert.equal(page.calls.length, 1);
  await page.runTimer(12000);
  assert.equal(page.status.dataset.state, 'waiting');
  assert.equal(page.hasTimer(60000), true);
  page.respond = async () => new Response(JSON.stringify(fixture()));
  page.element('retry-button').fire('click');
  await page.settle();
  assert.equal(page.status.dataset.state, 'updated');
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
  page.element('fullscreen-toggle').fire('click');
  await page.settle();
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
  page.element('fullscreen-toggle').fire('click');
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

test('ZIP save is local-only, survives polling/reload, and rejects markup as a ZIP', async () => {
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
  assert.equal(page.calls.length, requestCount);
  await page.runTimer(60000);
  assert.equal(page.element('weather-location').textContent, 'ZIP 00000-0000');

  const reload = browser();
  reload.window.localStorage = storage;
  reload.respond = async () => new Response('{}', { status: 503 });
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
  assert.equal(page.element('weather-location').textContent, 'Sample weather');
  assert.match(page.element('location-status').textContent, /preferences that are not ZIP codes are not used/);
  assert.equal(storage.getItem('sabio.location.v1'), legacy);
  page.element('location-open').fire('click');
  assert.equal(page.element('location-reset').hidden, false);
  page.element('location-cancel').fire('click');
  assert.equal(storage.getItem('sabio.location.v1'), legacy);
  page.element('location-open').fire('click');
  page.element('location-reset').fire('click');
  assert.equal(storage.getItem('sabio.location.v1'), null);
  assert.equal(page.element('weather-location').textContent, 'Sample weather');
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
  assert.equal(page.element('weather-location').textContent, 'Sample weather');

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
