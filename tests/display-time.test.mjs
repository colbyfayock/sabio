import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

// This file runs in its own test process; keep browser-local fixtures deterministic.
process.env.TZ = 'UTC';

const moduleBuild = await build({
  entryPoints: ['web/display-time.ts'], bundle: true, format: 'esm', target: 'firefox68', write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleBuild.outputFiles[0].text).toString('base64')}`;
const { THEME_STORAGE_NAME, displayTime, themeForHour } = await import(moduleUrl);

const initializeBuild = await build({
  entryPoints: ['web/display-time.ts'], bundle: true, format: 'iife', globalName: 'DisplayTimeModule', target: 'firefox68', write: false,
});
const initializeSource = initializeBuild.outputFiles[0].text;

test('displayTime uses the selected timezone instead of the browser local timezone', () => {
  const originalTimeZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const instant = new Date('2024-01-01T01:30:00.000Z');
    const browserLocal = displayTime(instant);
    const selected = displayTime(instant, 'Asia/Tokyo');

    assert.deepEqual(browserLocal, {
      clock: '5:30', meridiem: 'PM', date: 'Sunday, December 31', hour: 17,
    });
    assert.deepEqual(selected, {
      clock: '10:30', meridiem: 'AM', date: 'Monday, January 1', hour: 10,
    });
    assert.notDeepEqual(selected, browserLocal);
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

test('displayTime resolves both sides of spring-forward and fall-back transitions', () => {
  const springBefore = displayTime(new Date('2024-03-10T06:59:00.000Z'), 'America/New_York');
  const springAfter = displayTime(new Date('2024-03-10T07:01:00.000Z'), 'America/New_York');
  assert.deepEqual([springBefore.clock, springBefore.meridiem, springBefore.hour], ['1:59', 'AM', 1]);
  assert.deepEqual([springAfter.clock, springAfter.meridiem, springAfter.hour], ['3:01', 'AM', 3]);
  assert.equal(springBefore.date, 'Sunday, March 10');
  assert.equal(springAfter.date, 'Sunday, March 10');

  const fallBefore = displayTime(new Date('2024-11-03T05:59:00.000Z'), 'America/New_York');
  const fallAfter = displayTime(new Date('2024-11-03T06:01:00.000Z'), 'America/New_York');
  assert.deepEqual([fallBefore.clock, fallBefore.meridiem, fallBefore.hour], ['1:59', 'AM', 1]);
  assert.deepEqual([fallAfter.clock, fallAfter.meridiem, fallAfter.hour], ['1:01', 'AM', 1]);
  assert.equal(fallBefore.date, 'Sunday, November 3');
  assert.equal(fallAfter.date, 'Sunday, November 3');
});

test('automatic theme uses light from 7 through 18 and dark at night', () => {
  assert.equal(themeForHour('auto', 6), 'dark');
  assert.equal(themeForHour('auto', 7), 'light');
  assert.equal(themeForHour('auto', 18), 'light');
  assert.equal(themeForHour('auto', 19), 'dark');
});

test('manual theme modes override the hour boundaries', () => {
  for (const hour of [0, 6, 7, 18, 19, 23]) {
    assert.equal(themeForHour('light', hour), 'light');
    assert.equal(themeForHour('dark', hour), 'dark');
  }
});

function fixedDate(iso) {
  return class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [iso])); }
  };
}

function displayBrowser({ storage, blocked = false, now = '2024-06-01T11:00:00.000Z' }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const node = {
        textContent: '', value: '', attributes: {}, listeners: new Map(),
        addEventListener(name, callback) { this.listeners.set(name, callback); },
        fire(name) { this.listeners.get(name)?.(); },
      };
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const root = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const document = {
    documentElement: root,
    getElementById: element,
    addEventListener() {},
  };
  const window = {
    get localStorage() {
      if (blocked) throw new Error('Storage blocked');
      return storage;
    },
    setInterval() { return 1; },
  };
  const context = { DisplayTimeModule: undefined, document, window, Date: fixedDate(now), Intl };
  vm.runInNewContext(initializeSource, context);
  const controller = context.DisplayTimeModule.initializeDisplayTime();
  return { controller, element, root, document };
}

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test('appearance preference initializes and survives a reload', () => {
  const storage = memoryStorage({ [THEME_STORAGE_NAME]: 'dark' });
  const first = displayBrowser({ storage, now: '2024-06-01T11:00:00.000Z' });
  assert.equal(first.element('themeMode').value, 'dark');
  assert.equal(first.root.attributes['data-theme'], 'dark');

  first.element('themeMode').value = 'auto';
  first.element('themeMode').fire('change');
  assert.equal(storage.getItem(THEME_STORAGE_NAME), 'auto');

  const reloaded = displayBrowser({ storage, now: '2024-06-01T11:00:00.000Z' });
  assert.equal(reloaded.element('themeMode').value, 'auto');
  assert.equal(reloaded.root.attributes['data-theme'], 'light');
});

test('blocked appearance storage falls back to visit-only state and remains usable', () => {
  const page = displayBrowser({ storage: memoryStorage(), blocked: true, now: '2024-06-01T23:00:00.000Z' });
  assert.equal(page.element('themeMode').value, 'auto');
  assert.equal(page.root.attributes['data-theme'], 'dark');
  assert.match(page.element('appearance-status').textContent, /lasts for this visit/);

  page.element('themeMode').value = 'light';
  page.element('themeMode').fire('change');
  assert.equal(page.root.attributes['data-theme'], 'light');
  assert.match(page.element('appearance-status').textContent, /lasts for this visit/);
});

test('timezone updates refresh both the displayed label and all time fields', () => {
  const page = displayBrowser({ storage: memoryStorage(), now: '2024-01-01T01:30:00.000Z' });
  page.controller.setTimeZone('Asia/Tokyo', true);
  assert.equal(page.element('time-zone').textContent, 'Asia/Tokyo');
  assert.equal(page.element('clock').textContent, '10:30');
  assert.equal(page.element('meridiem').textContent, 'AM');
  assert.equal(page.element('date').textContent, 'Monday, January 1');

  page.controller.setTimeZone(null, true);
  assert.equal(page.element('time-zone').textContent, 'Browser time · ZIP timezone pending');
});
