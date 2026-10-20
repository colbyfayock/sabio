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
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name) { this.listeners.get(name)?.(); }
}

function browser() {
  const ids = new Map();
  const element = (id) => {
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  };
  const status = new Element();
  const document = new Element();
  document.getElementById = element;
  document.querySelector = () => status;
  document.createElement = () => new Element();
  document.documentElement = new Element();
  const window = new Element();
  const timers = new Map();
  let nextTimer = 0;
  window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => ++nextTimer;
  const navigator = { onLine: true };
  const calls = [];
  const instance = {
    element, status, document, window, navigator, timers, calls,
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
