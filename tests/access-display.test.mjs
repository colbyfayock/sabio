import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/access.ts'], bundle: true, format: 'iife', globalName: 'AccessModule', target: 'firefox68', write: false,
});
const source = compiled.outputFiles[0].text;

class Element {
  constructor() {
    this.textContent = '';
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = true;
    this.disabled = false;
    this.focused = false;
    this.innerHTMLWrites = [];
    Object.defineProperty(this, 'innerHTML', {
      get: () => '',
      set: (value) => this.innerHTMLWrites.push(value),
    });
  }

  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name, event = {}) { return this.listeners.get(name)?.(event); }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll() { return this.controls ?? []; }
  contains(target) { return target === this; }
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function browser(fetcher) {
  const elements = new Map();
  const timers = new Map();
  const intervals = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const requests = [];
  const controls = ['link', 'button', 'input'].map(() => new Element());
  let timerID = 0;
  let intervalID = 0;
  let reloads = 0;

  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const page = new Element();
  page.controls = controls;
  const document = {
    getElementById: element,
    querySelector(selector) { return selector === '.page-shell' ? page : null; },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const window = {
    location: { reload() { reloads += 1; } },
    setTimeout(callback, delay) {
      const id = ++timerID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = ++intervalID;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  const fetch = (input, options) => {
    requests.push({ input, options });
    return fetcher(input, options);
  };
  const context = { AccessModule: undefined, document, window, fetch, AbortController, JSON };
  vm.runInNewContext(source, context);

  return {
    initialize: () => context.AccessModule.initializeAccess(),
    element,
    page,
    controls,
    timers,
    intervals,
    requests,
    reloadCount: () => reloads,
    async settle() { await new Promise(setImmediate); },
    async runTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
      await this.settle();
    },
    async runInterval(delay) {
      const entry = [...intervals].find(([, interval]) => interval.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms interval`);
      entry[1].callback();
      await this.settle();
    },
    fireWindow(name) { return windowListeners.get(name)?.(); },
    fireDocument(name, event) { return documentListeners.get(name)?.(event); },
  };
}

function assertSameOriginRequest({ input, options }, path, method) {
  assert.equal(input, path);
  assert.equal(new URL(input, 'https://display.example').username, '');
  assert.equal(new URL(input, 'https://display.example').password, '');
  assert.equal(new URL(input, 'https://display.example').search, '');
  assert.equal(options.method, method);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.mode, undefined);
  assert.equal(options.username, undefined);
  assert.equal(options.password, undefined);
  assert.equal(options.url, undefined);
  assert.equal(options.headers?.Origin, undefined);
}

test('preview bootstrap returns preview without opening the access gate', async () => {
  const page = browser(async () => response({ mode: 'preview' }));

  assert.equal(await page.initialize(), 'preview');
  assert.equal(page.element('access-dialog').hidden, true);
  assert.equal(page.requests.length, 1);
  assertSameOriginRequest(page.requests[0], '/api/bootstrap', 'GET');
  assert.equal(page.requests[0].options.body, undefined);
});

test('enrolled managed display returns managed and reloads after periodic revocation check', async () => {
  let bootstrapCount = 0;
  const page = browser(async (path) => {
    assert.equal(path, '/api/bootstrap');
    bootstrapCount += 1;
    return response(bootstrapCount === 1
      ? { mode: 'managed', enrolled: true }
      : { mode: 'managed', enrolled: false });
  });

  assert.equal(await page.initialize(), 'managed');
  assert.equal(page.element('access-dialog').hidden, true);
  assert.equal(page.intervals.size, 1);
  await page.runInterval(60000);

  assert.equal(bootstrapCount, 2);
  assert.equal(page.reloadCount(), 1);
  assert.equal(page.requests.length, 2);
  for (const request of page.requests) assertSameOriginRequest(request, '/api/bootstrap', 'GET');
});

test('a rate-limited bootstrap check is treated as transient and does not reload', async () => {
  let bootstrapCount = 0;
  const page = browser(async (path) => {
    assert.equal(path, '/api/bootstrap');
    bootstrapCount += 1;
    return bootstrapCount === 1
      ? response({ mode: 'managed', enrolled: true })
      : response({ error: 'rate_limited' }, 429);
  });

  assert.equal(await page.initialize(), 'managed');
  assert.equal(page.element('access-dialog').hidden, true);
  await page.runInterval(60000);

  assert.equal(bootstrapCount, 2);
  assert.equal(page.reloadCount(), 0);
});

test('unapproved managed display shows and focuses an isolated access gate without data requests', async () => {
  const page = browser(async () => response({ mode: 'managed', enrolled: false }));

  assert.equal(await page.initialize(), null);
  assert.equal(page.element('access-dialog').hidden, false);
  assert.equal(page.element('access-start').focused, true);
  assert.equal(page.page.attributes['aria-hidden'], 'true');
  assert.ok(page.controls.every((control) => control.attributes.tabindex === '-1'));
  assert.match(page.element('access-status').textContent, /needs owner approval/);
  assert.equal(page.requests.length, 1);
  assertSameOriginRequest(page.requests[0], '/api/bootstrap', 'GET');
});

test('pairing uses same-origin credentialed POSTs, polls pending completion, then reloads', async () => {
  const code = '<img src=x onerror=alert(1)>';
  let completionCount = 0;
  const page = browser(async (path) => {
    if (path === '/api/bootstrap') return response({ mode: 'managed', enrolled: false });
    if (path === '/api/enrollment') return response({ code });
    if (path === '/api/enrollment/complete') {
      completionCount += 1;
      return completionCount === 1
        ? response({ status: 'pending' }, 202)
        : response({ status: 'approved' }, 200);
    }
    assert.fail(`Unexpected request path: ${path}`);
  });

  assert.equal(await page.initialize(), null);
  page.element('access-start').fire('click');
  await page.settle();

  const displayedCode = page.element('access-code');
  assert.equal(displayedCode.textContent, code);
  assert.deepEqual(displayedCode.innerHTMLWrites, []);
  assert.equal(page.element('access-start').disabled, true);
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 10000));

  const enrollmentRequest = page.requests[1];
  assertSameOriginRequest(enrollmentRequest, '/api/enrollment', 'POST');
  assert.deepEqual(JSON.parse(enrollmentRequest.options.body), {});
  assert.equal(enrollmentRequest.options.headers['Content-Type'], 'application/json');

  await page.runTimer(10000);
  assert.match(page.element('access-status').textContent, /Waiting for the owner/);
  const pendingRequest = page.requests[2];
  assertSameOriginRequest(pendingRequest, '/api/enrollment/complete', 'POST');
  assert.deepEqual(JSON.parse(pendingRequest.options.body), {});
  assert.ok([...page.timers.values()].some((timer) => timer.delay === 10000));

  await page.runTimer(10000);
  assert.equal(page.reloadCount(), 1);
  assert.equal(page.requests.length, 4);
  assertSameOriginRequest(page.requests[3], '/api/enrollment/complete', 'POST');
  assert.deepEqual(JSON.parse(page.requests[3].options.body), {});
  assert.ok(page.requests.every(({ input }) => !input.includes('@')));
});

test('bootstrap failure fails closed, offers retry, and reloads on retry or online recovery', async () => {
  const page = browser(async () => { throw new Error('synthetic offline response'); });

  assert.equal(await page.initialize(), null);
  assert.equal(page.element('access-dialog').hidden, false);
  assert.equal(page.element('access-start').disabled, false);
  assert.equal(page.element('access-start').textContent, 'Retry connection');
  assert.match(page.element('access-status').textContent, /Cannot verify display access/);
  assert.equal(page.requests.length, 1);

  page.element('access-start').fire('click');
  page.fireWindow('online');
  assert.equal(page.reloadCount(), 2);
  assert.equal(page.requests.length, 1);
});

test('requests have a bounded 12-second timeout for bootstrap and enrollment', async () => {
  const makeAbortableFetch = () => async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  });
  const bootstrap = browser(makeAbortableFetch());
  const bootstrapResult = bootstrap.initialize();
  await bootstrap.settle();
  await bootstrap.runTimer(12000);
  assert.equal(await bootstrapResult, null);
  assert.equal(bootstrap.timers.size, 0);
  assert.match(bootstrap.element('access-status').textContent, /Cannot verify display access/);

  const enrollment = browser(async (path, options) => {
    if (path === '/api/bootstrap') return response({ mode: 'managed', enrolled: false });
    return makeAbortableFetch()(path, options);
  });
  assert.equal(await enrollment.initialize(), null);
  enrollment.element('access-start').fire('click');
  await enrollment.settle();
  await enrollment.runTimer(12000);
  assert.equal(enrollment.element('access-start').disabled, false);
  assert.match(enrollment.element('access-status').textContent, /Could not request a code/);
  assert.equal(enrollment.timers.size, 0);
});
