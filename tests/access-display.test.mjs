import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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
  removeAttribute(name) { delete this.attributes[name]; }
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
  assert.equal(page.page.hidden, false);
  assert.ok(page.controls.every((control) => control.attributes.tabindex === undefined));
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
  assert.equal(page.page.hidden, false);
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

test('unapproved managed display shows and focuses an isolated pairing form without data requests', async () => {
  const page = browser(async () => response({ mode: 'managed', enrolled: false }));

  assert.equal(await page.initialize(), null);
  assert.equal(page.element('access-dialog').hidden, false);
  assert.equal(page.element('access-pair-form').hidden, false);
  assert.equal(page.element('access-retry').hidden, true);
  assert.equal(page.element('access-pair-code').focused, true);
  assert.equal(page.page.hidden, true);
  assert.equal(page.page.attributes['aria-hidden'], 'true');
  assert.ok(page.controls.every((control) => control.attributes.tabindex === '-1'));
  assert.match(page.element('access-status').textContent, /Enter the one-time pairing code/);
  assert.equal(page.requests.length, 1);
  assertSameOriginRequest(page.requests[0], '/api/bootstrap', 'GET');
});

test('the page shell and pairing form stay hidden until bootstrap resolves', async () => {
  const html = await readFile('web/index.html', 'utf8');
  assert.match(html, /<main class="page-shell frame" hidden>/);
  assert.match(html, /id="access-pair-form" hidden/);
  assert.match(html, /id="access-pair-code"/);
  assert.match(html, /id="access-pair-submit"/);
  assert.match(html, /id="access-retry" type="button" hidden/);
  assert.doesNotMatch(html, /access-start/);
  assert.match(html, /id="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-title">/);
});

test('pairing submits a normalized same-origin code once and reloads after success', async () => {
  const page = browser(async (path) => {
    if (path === '/api/bootstrap') return response({ mode: 'managed', enrolled: false });
    if (path === '/api/enrollment/claim') return response({ status: 'paired' });
    assert.fail(`Unexpected request path: ${path}`);
  });

  assert.equal(await page.initialize(), null);
  const input = page.element('access-pair-code');
  const submit = page.element('access-pair-submit');
  input.value = 'ab-cd ef gh jk';
  let prevented = false;
  await page.element('access-pair-form').fire('submit', { preventDefault() { prevented = true; } });
  await page.settle();

  assert.equal(prevented, true);
  assert.equal(page.reloadCount(), 1);
  assert.equal(page.requests.length, 2);
  const claimRequest = page.requests[1];
  assertSameOriginRequest(claimRequest, '/api/enrollment/claim', 'POST');
  assert.deepEqual(JSON.parse(claimRequest.options.body), { code: 'ABCDEFGHJK' });
  assert.equal(claimRequest.options.headers['Content-Type'], 'application/json');
  assert.equal(submit.disabled, false);
  assert.equal(input.disabled, false);
  assert.equal(input.focused, true);
  assert.deepEqual(input.innerHTMLWrites, []);
  assert.ok(page.requests.every(({ input: path }) => !path.includes('@')));
});

test('an invalid code is rejected locally without a request, and denial messages keep the form usable', async () => {
  let claimStatus = 401;
  const page = browser(async (path) => {
    if (path === '/api/bootstrap') return response({ mode: 'managed', enrolled: false });
    if (path === '/api/enrollment/claim') return response({ error: 'pairing_denied' }, claimStatus);
    assert.fail(`Unexpected request path: ${path}`);
  });

  assert.equal(await page.initialize(), null);
  const input = page.element('access-pair-code');
  const submit = page.element('access-pair-submit');
  const form = page.element('access-pair-form');
  input.value = 'short';
  await form.fire('submit', { preventDefault() {} });
  await page.settle();
  assert.equal(page.requests.length, 1);
  assert.match(page.element('access-status').textContent, /10-character pairing code/);

  input.value = 'ABCDEFGHJK';
  await form.fire('submit', { preventDefault() {} });
  await page.settle();
  assert.equal(page.reloadCount(), 0);
  assert.match(page.element('access-status').textContent, /invalid or expired/);
  assert.equal(input.disabled, false);
  assert.equal(submit.disabled, false);

  claimStatus = 429;
  await form.fire('submit', { preventDefault() {} });
  await page.settle();
  assert.equal(page.reloadCount(), 0);
  assert.match(page.element('access-status').textContent, /Too many pairing attempts/);
});

test('bootstrap failure fails closed, offers retry, and reloads on retry or online recovery', async () => {
  const page = browser(async () => { throw new Error('synthetic offline response'); });

  assert.equal(await page.initialize(), null);
  assert.equal(page.element('access-dialog').hidden, false);
  assert.equal(page.element('access-pair-form').hidden, true);
  assert.equal(page.element('access-retry').hidden, false);
  assert.equal(page.element('access-retry').focused, true);
  assert.equal(page.page.hidden, true);
  assert.match(page.element('access-status').textContent, /Cannot verify display access/);
  assert.equal(page.requests.length, 1);

  page.element('access-retry').fire('click');
  page.fireWindow('online');
  assert.equal(page.reloadCount(), 2);
  assert.equal(page.requests.length, 1);
});

test('requests have a bounded 12-second timeout for bootstrap and pairing', async () => {
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

  const pairing = browser(async (path, options) => {
    if (path === '/api/bootstrap') return response({ mode: 'managed', enrolled: false });
    return makeAbortableFetch()(path, options);
  });
  assert.equal(await pairing.initialize(), null);
  pairing.element('access-pair-code').value = 'ABCDEFGHJK';
  await pairing.element('access-pair-form').fire('submit', { preventDefault() {} });
  await pairing.settle();
  await pairing.runTimer(12000);
  assert.equal(pairing.element('access-pair-submit').disabled, false);
  assert.equal(pairing.element('access-pair-code').disabled, false);
  assert.match(pairing.element('access-status').textContent, /Could not pair this display/);
  assert.equal(pairing.timers.size, 0);
});
