import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const output = await build({ entryPoints: ['src/owner.ts'], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { verifyOwner, validOwnerConfiguration } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const config = { teamDomain: 'https://sample-team.cloudflareaccess.com', audience: 'a'.repeat(64), email: 'owner@example.com' };
const now = new Date('2026-10-21T12:00:00Z');
const pair = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const json = (value, extra = {}) => Response.json(value, extra);
const fetcher = async (input, options) => {
  assert.equal(String(input), `${config.teamDomain}/cdn-cgi/access/certs`);
  assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, undefined);
  assert.equal(options.headers.Cookie, undefined);
  return json({ keys: [jwk] });
};
async function signed(overrides = {}, key = pair.privateKey, header = {}) {
  return new SignJWT({ iss: config.teamDomain, aud: [config.audience], sub: 'synthetic-subject', email: config.email,
    type: 'app', iat: now.getTime() / 1000 - 60, nbf: now.getTime() / 1000 - 60, exp: now.getTime() / 1000 + 600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', ...header }).sign(key);
}
const request = (token, extra = {}) => new Request('https://example.com/api/admin/displays', { headers: { 'Cf-Access-Jwt-Assertion': token, ...extra } });

test('owner verification requires a valid signature, configured issuer/audience and actual owner identity', async () => {
  assert.equal(await verifyOwner(request(await signed()), config, { now, fetcher }), true);
  for (const change of [
    { iss: 'https://other.cloudflareaccess.com' }, { aud: ['b'.repeat(64)] },
    { email: 'other@example.com' }, { type: 'org' }, { sub: '' }, { email: undefined },
    { exp: now.getTime() / 1000 }, { iat: now.getTime() / 1000 + 10 }, { nbf: now.getTime() / 1000 + 10 },
  ]) assert.equal(await verifyOwner(request(await signed(change)), config, { now, fetcher }), false);
  const otherKey = await generateKeyPair('RS256');
  assert.equal(await verifyOwner(request(await signed({}, otherKey.privateKey)), config, { now, fetcher }), false);
});

test('plain identity headers, service tokens, missing tokens, bad algorithms and invalid config never authenticate', async () => {
  assert.equal(await verifyOwner(new Request('https://example.com/', { headers: { 'Cf-Access-Authenticated-User-Email': config.email } }), config, { now, fetcher }), false);
  assert.equal(await verifyOwner(request('x'.repeat(8193)), config, { now, fetcher }), false);
  assert.equal(await verifyOwner(request('eyJhbGciOiJub25lIn0.e30.'), config, { now, fetcher }), false);
  assert.equal(await verifyOwner(request(await signed({ email: undefined, sub: '', common_name: 'service.access' })), config, { now, fetcher }), false);
  for (const teamDomain of ['http://sample.cloudflareaccess.com', 'https://evil.example.com', 'https://sample.cloudflareaccess.com/path']) {
    assert.equal(validOwnerConfiguration({ ...config, teamDomain }), false);
  }
  let calls = 0;
  assert.equal(await verifyOwner(request(await signed()), { ...config, audience: '' }, { now, fetcher: async () => { calls++; } }), false);
  assert.equal(calls, 0);
});

test('JWKS redirects, oversized bodies and network failure deny identity without leaking details', async () => {
  const token = await signed();
  for (const badFetcher of [
    async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.com' } }),
    async () => json({ extra: 'x'.repeat(33000) }),
    async () => { throw new Error('private diagnostic'); },
    async () => json({ keys: [] }),
  ]) assert.equal(await verifyOwner(request(token), config, { now, fetcher: badFetcher }), false);
});

test('only public signing certificates are cached; cache errors cannot authenticate invalid tokens', async () => {
  const entries = new Map();
  const cache = { async match(request) { return entries.get(request.url)?.clone(); }, async put(request, response) { entries.set(request.url, response.clone()); } };
  let calls = 0;
  const countFetcher = async (...args) => { calls++; return fetcher(...args); };
  const token = await signed();
  assert.equal(await verifyOwner(request(token), config, { now, cache, fetcher: countFetcher }), true);
  assert.equal(await verifyOwner(request(token), config, { now, cache, fetcher: countFetcher }), true);
  assert.equal(calls, 1);
  assert.equal(entries.size, 1);
  assert.equal([...entries.keys()][0], `${config.teamDomain}/cdn-cgi/access/certs`);
  const broken = { async match() { throw new Error('private'); }, async put() { throw new Error('private'); } };
  assert.equal(await verifyOwner(request(token), config, { now, cache: broken, fetcher }), true);
  assert.equal(await verifyOwner(request('bad.token.signature'), config, { now, cache: broken, fetcher }), false);
});
