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

function start(displays) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const document = { getElementById: element, createElement: (tag) => new Element(tag) };
  const window = { setTimeout: () => 1, clearTimeout() {} };
  const calls = [];
  const fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/displays') return { ok: true, status: 200, json: async () => ({ displays }) };
    if (path === '/api/admin/label') return { ok: true, status: 200, json: async () => ({ status: 'updated' }) };
    if (path === '/api/admin/revoke') return { ok: true, status: 204, json: async () => null };
    throw new Error('unexpected_route');
  };
  vm.runInNewContext(source, { document, window, fetch, AbortController, Date, JSON, Number, String, Boolean, Array, Error });
  return { element, calls };
}

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
