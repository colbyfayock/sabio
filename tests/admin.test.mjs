import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['web/admin.ts'], bundle: true, format: 'iife', target: 'firefox68', write: false });
const source = compiled.outputFiles[0].text;

class Element {
  constructor(id = '') {
    this.id = id;
    this.tagName = id.toLowerCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  async fire(type, event = { preventDefault() {} }) { return this.listeners.get(type)?.(event); }
}

function start(displays, pairing = { code: 'ABCDEFGHJK', expiresAt: 1792670000, status: 201 }, photos = { photos: [], activeImport: null, googleConnected: false }) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const document = { getElementById: element, createElement: (tag) => new Element(tag) };
  const navigations = [];
  const window = { setTimeout: () => 1, clearTimeout() {}, location: { search: '', assign(value) { navigations.push(value); } } };
  const calls = [];
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/displays') return { ok: true, status: 200, json: async () => ({ displays }) };
    if (path === '/api/admin/photos') return { ok: true, status: 200, json: async () => photos };
    if (path === '/api/admin/photos/connect') {
      if (photos.googleConnected) {
        photos.activeImport = { id: '123e4567-e89b-12d3-a456-426614174000', pickerUri: 'https://photos.google.com/picker?session=synthetic' };
        return { ok: true, status: 200, json: async () => ({ status: 'picker_ready' }) };
      }
      return { ok: true, status: 200, json: async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' }) };
    }
    if (path === '/api/admin/photos/disconnect') {
      photos.googleConnected = false;
      photos.activeImport = null;
      return { ok: true, status: 200, json: async () => ({ disconnected: true, googleRevoked: true }) };
    }
    if (path === '/api/admin/label') return { ok: true, status: 200, json: async () => ({ status: 'updated' }) };
    if (path === '/api/admin/revoke') return { ok: true, status: 204, json: async () => null };
    if (path === '/api/admin/pairing') {
      return {
        ok: pairing.status === 201,
        status: pairing.status,
        json: async () => ({ code: pairing.code, expiresAt: pairing.expiresAt }),
      };
    }
    throw new Error('unexpected_route');
  };
  vm.runInNewContext(source, { document, window, fetch, AbortController, URL, URLSearchParams, Date, JSON, Number, String, Boolean, Array, Error });
  return { element, calls, navigations };
}

test('admin validates and opens the owner-only Picker URL from a Google Photos import', async () => {
  const app = start([], undefined, {
    photos: [],
    activeImport: { id: '123e4567-e89b-12d3-a456-426614174000', pickerUri: 'https://photos.google.com/picker?session=synthetic' },
    googleConnected: true,
  });
  await new Promise(setImmediate);
  assert.equal(app.element('photos-import-panel').hidden, false);
  assert.equal(app.element('photos-picker-link').href, 'https://photos.google.com/picker?session=synthetic');
  assert.equal(app.element('photos-disconnect').hidden, false);
});

test('connected Google Photos can open another Picker session without OAuth and can disconnect', async () => {
  const app = start([], undefined, { photos: [], activeImport: null, googleConnected: true });
  await new Promise(setImmediate);
  assert.equal(app.element('photos-connect').textContent, 'Open Google Photos Picker');
  await app.element('photos-connect').fire('click');
  await new Promise(setImmediate);
  assert.equal(app.navigations.length, 0, 'reusing the saved connection does not send the user through OAuth');
  assert.equal(app.element('photos-import-panel').hidden, false);
  await app.element('photos-disconnect').fire('click');
  await new Promise(setImmediate);
  assert.equal(app.element('photos-disconnect').hidden, true);
  assert.equal(app.element('photos-connect').textContent, 'Connect Google Photos');
});

test('unconnected Google Photos starts the OAuth authorization flow', async () => {
  const app = start([]);
  await new Promise(setImmediate);
  await app.element('photos-connect').fire('click');
  await new Promise(setImmediate);
  assert.equal(new URL(app.navigations[0]).hostname, 'accounts.google.com');
});

test('revoked browser entries are grouped in a closed history disclosure without active controls', async () => {
  const app = start([
    { id: 'active-id', name: 'Living room frame', createdAt: 1792670000, expiresAt: 1795262000, revoked: false, revokedAt: null,
      device: { type: 'tablet', browser: 'Firefox 68.11.0', os: 'Android 4.4.2' }, lastSeenAt: 1792670400, weatherArea: null },
    { id: 'revoked-id', name: null, createdAt: 1792660000, expiresAt: 1795252000, revoked: true, revokedAt: 1792675000,
      device: { type: 'unknown', browser: null, os: null }, lastSeenAt: null, weatherArea: null },
  ]);
  await new Promise(setImmediate);
  const active = app.element('admin-displays');
  const history = app.element('revoked-history');
  const revoked = app.element('revoked-displays');
  assert.equal(active.children.length, 1);
  assert.equal(history.hidden, false);
  assert.equal(history.open, false);
  assert.match(app.element('revoked-summary').textContent, /1/);
  assert.equal(revoked.children.length, 1);
  assert.match(revoked.children[0].children.at(-1).textContent, /Revoked/);
  assert.equal(revoked.children[0].children.some((child) => child.tagName === 'button' || child.tagName === 'form'), false);
  assert.equal(active.children[0].children.some((child) => child.tagName === 'button'), true);
});

test('empty revoked history is hidden, and active entries still allow nickname edits', async () => {
  const app = start([
    { id: 'active-id', name: null, createdAt: 1792670000, expiresAt: 1795262000, revoked: false, revokedAt: null,
      device: { type: 'desktop', browser: 'Chrome 124.0', os: 'macOS' }, lastSeenAt: 1792670400, weatherArea: null },
  ]);
  await new Promise(setImmediate);
  const history = app.element('revoked-history');
  assert.equal(history.hidden, true);
  const form = app.element('admin-displays').children[0].children.find((child) => child.tagName === 'form');
  assert.ok(form);
  const save = form.children[2];
  form.children[1].value = 'Kitchen display';
  await form.fire('submit');
  await new Promise(setImmediate);
  const rename = app.calls.find((call) => call.path === '/api/admin/label');
  assert.deepEqual(JSON.parse(rename.options.body), { id: 'active-id', name: 'Kitchen display' });
});

test('the owner can generate a one-time pairing code and sees its expiry instructions', async () => {
  const app = start([]);
  await new Promise(setImmediate);
  const form = app.element('pairing-form');
  const button = app.element('pairing-generate');
  const code = app.element('pairing-code');
  assert.equal(form.listeners.has('submit'), true);

  await form.fire('submit', { preventDefault() {} });
  await new Promise(setImmediate);

  const pairing = app.calls.find((call) => call.path === '/api/admin/pairing');
  assert.equal(pairing.options.method, 'POST');
  assert.equal(pairing.options.credentials, 'same-origin');
  assert.equal(pairing.options.headers['Content-Type'], 'application/json');
  assert.equal(pairing.options.body, '{}');
  assert.equal(code.textContent, 'ABCDEFGHJK');
  assert.match(app.element('admin-status').textContent, /before .*It can be used once\./);
  assert.equal(button.disabled, false);
});

test('a failed pairing-code request clears the code and keeps the form usable', async () => {
  const app = start([], { code: '', expiresAt: 0, status: 503 });
  await new Promise(setImmediate);
  const form = app.element('pairing-form');
  const code = app.element('pairing-code');
  code.textContent = 'OLDCODE';
  await form.fire('submit', { preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(code.textContent, '');
  assert.match(app.element('admin-status').textContent, /Could not generate a pairing code/);
  assert.equal(app.element('pairing-generate').disabled, false);
});
