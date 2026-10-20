import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['web/location.ts'], bundle: true, format: 'esm', target: 'firefox68', write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
const {
  LOCATION_STORAGE_KEY,
  normalizeZipCode,
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

test('ZIP validation accepts ZIP5 and ZIP+4 while preserving leading zeroes', () => {
  assert.equal(normalizeZipCode(' 00000 '), '00000');
  assert.equal(normalizeZipCode('00000-0000'), '00000-0000');
  assert.equal(normalizeZipCode('\t00000-0000 '), null);
});

test('ZIP validation rejects non-strings, malformed values, controls, and non-ASCII digits', () => {
  for (const value of [
    '', '   ', null, 12345, '1234', '123456', '12345 6789', '12345-678', '12345-67890',
    '１２３４５', '١٢٣٤٥', '1234５', '12\n345', '\n12345', '12345\t', '12345-6789x',
  ]) {
    assert.equal(normalizeZipCode(value), null, `Expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('reads only a valid bounded version 2 ZIP preference record', () => {
  const storage = memoryStorage({
    [LOCATION_STORAGE_KEY]: JSON.stringify({ version: 2, zipCode: '00000-0000' }),
  });
  assert.deepEqual(readLocationPreference(storage), {
    zipCode: '00000-0000', available: true, hasStoredPreference: true,
  });

  for (const value of [
    '{not json',
    JSON.stringify({ version: 1, label: 'Sample City' }),
    JSON.stringify({ version: 2, label: '00000' }),
    JSON.stringify({ version: 2, zipCode: '0000' }),
    JSON.stringify({ version: 2, zipCode: '00000', extra: true }),
    'x'.repeat(513),
  ]) {
    storage.setItem(LOCATION_STORAGE_KEY, value);
    assert.deepEqual(readLocationPreference(storage), {
      zipCode: null, available: true, hasStoredPreference: true,
    });
  }
  assert.deepEqual(readLocationPreference(memoryStorage()), {
    zipCode: null, available: true, hasStoredPreference: false,
  });
});

test('legacy city preference is neither converted nor modified by reading', () => {
  const legacy = JSON.stringify({ version: 1, label: 'Sample City' });
  const storage = memoryStorage({ [LOCATION_STORAGE_KEY]: legacy });
  assert.deepEqual(readLocationPreference(storage), {
    zipCode: null, available: true, hasStoredPreference: true,
  });
  assert.equal(storage.getItem(LOCATION_STORAGE_KEY), legacy);
});

test('writes normalized version 2 ZIP records and catches storage failures', () => {
  const storage = memoryStorage();
  assert.equal(writeLocationPreference(storage, ' 00000-0000 '), true);
  assert.deepEqual(JSON.parse(storage.getItem(LOCATION_STORAGE_KEY)), {
    version: 2,
    zipCode: '00000-0000',
  });
  assert.equal(writeLocationPreference(storage, 12345), false);
  assert.equal(writeLocationPreference(storage, 'Sample City'), false);

  const readFailure = { ...storage, getItem() { throw new Error('blocked'); } };
  assert.deepEqual(readLocationPreference(readFailure), {
    zipCode: null, available: false, hasStoredPreference: false,
  });
  assert.deepEqual(readLocationPreference(() => { throw new Error('blocked'); }), {
    zipCode: null, available: false, hasStoredPreference: false,
  });
  assert.equal(writeLocationPreference({ ...storage, setItem() { throw new Error('blocked'); } }, '00000'), false);
  assert.equal(writeLocationPreference(() => { throw new Error('blocked'); }, '00000'), false);
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
