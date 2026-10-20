import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/location.ts'], bundle: true, format: 'esm', target: 'firefox68', write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
const {
  LOCATION_STORAGE_KEY,
  normalizeLocationLabel,
  readLocationPreference,
  resetLocationPreference,
  writeLocationPreference,
} = await import(moduleUrl);

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, value); },
    removeItem(key) { entries.delete(key); },
  };
}

test('location labels normalize Unicode whitespace and accept Unicode names', () => {
  assert.equal(normalizeLocationLabel('  São   Exemplo　Centro  '), 'São Exemplo Centro');
  assert.equal(normalizeLocationLabel('例の町'), '例の町');
  const astralLetter = String.fromCodePoint(0x10400);
  assert.equal(normalizeLocationLabel(astralLetter.repeat(80)), astralLetter.repeat(80));
});

test('location labels reject empty, non-string, control, invalid Unicode, and overlong values', () => {
  assert.equal(normalizeLocationLabel('   '), null);
  assert.equal(normalizeLocationLabel(''), null);
  assert.equal(normalizeLocationLabel(null), null);
  assert.equal(normalizeLocationLabel(42), null);
  assert.equal(normalizeLocationLabel('Sample\nCity'), null);
  assert.equal(normalizeLocationLabel('Sample\u0085City'), null);
  assert.equal(normalizeLocationLabel('\ud800'), null);
  assert.equal(normalizeLocationLabel('a'.repeat(81)), null);
});

test('reads only a valid bounded version 1 location record', () => {
  const storage = memoryStorage({
    [LOCATION_STORAGE_KEY]: JSON.stringify({ version: 1, label: 'Sample City' }),
  });
  assert.deepEqual(readLocationPreference(storage), { label: 'Sample City', available: true });

  for (const value of [
    '{not json',
    JSON.stringify({ version: 2, label: 'Sample City' }),
    JSON.stringify({ version: 1, label: 'Sample City', extra: true }),
    JSON.stringify({ version: 1, label: '' }),
    'x'.repeat(513),
  ]) {
    storage.setItem(LOCATION_STORAGE_KEY, value);
    assert.deepEqual(readLocationPreference(storage), { label: null, available: true });
  }
  assert.deepEqual(readLocationPreference(memoryStorage()), { label: null, available: true });
});

test('writes normalized versioned records and catches storage getter and method failures', () => {
  const storage = memoryStorage();
  assert.equal(writeLocationPreference(storage, ' Sample   City '), true);
  assert.deepEqual(JSON.parse(storage.getItem(LOCATION_STORAGE_KEY)), {
    version: 1,
    label: 'Sample City',
  });
  assert.equal(writeLocationPreference(storage, ''), false);

  const readFailure = { ...storage, getItem() { throw new Error('blocked'); } };
  assert.deepEqual(readLocationPreference(readFailure), { label: null, available: false });
  assert.deepEqual(readLocationPreference(() => { throw new Error('blocked'); }), { label: null, available: false });
  assert.equal(writeLocationPreference({ ...storage, setItem() { throw new Error('blocked'); } }, 'Sample City'), false);
  assert.equal(writeLocationPreference(() => { throw new Error('blocked'); }, 'Sample City'), false);
});

test('reset removes only the owned preference and catches remove failures', () => {
  const storage = memoryStorage({
    [LOCATION_STORAGE_KEY]: JSON.stringify({ version: 1, label: 'Sample City' }),
    'another.application.key': 'untouched',
  });
  assert.equal(resetLocationPreference(storage), true);
  assert.equal(storage.entries.has(LOCATION_STORAGE_KEY), false);
  assert.equal(storage.entries.get('another.application.key'), 'untouched');
  assert.equal(resetLocationPreference({ ...storage, removeItem() { throw new Error('blocked'); } }), false);
  assert.equal(resetLocationPreference(() => { throw new Error('blocked'); }), false);
});
