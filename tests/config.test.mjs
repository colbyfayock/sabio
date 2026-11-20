import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('every request runs through Worker routing without an SPA fallback', () => {
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.not_found_handling, '404-page');
});

test('local preview uses loopback with a local-only D1 placeholder, empty identity config and no provisioned resources', () => {
  assert.equal(config.dev.ip, '127.0.0.1');
  assert.equal(config.dev.local_protocol, 'http');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.send_metrics, false);
  assert.deepEqual(config.vars, { APP_MODE: 'preview', APP_ORIGIN: '', APP_ALLOWED_ORIGINS: '', ACCESS_TEAM_DOMAIN: '', ACCESS_AUDIENCE: '', OWNER_EMAIL: '', NOTIFY_FROM_EMAIL: '' });
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');
  assert.equal(config.d1_databases[0].remote, false);
  for (const name of ['kv_namespaces', 'r2_buckets', 'services', 'routes', 'account_id']) {
    assert.equal(config[name], undefined);
  }
});

test('location requests do not enable automatic URL logging or outbound URL traces', () => {
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.traces.enabled, false);
});

test('local configuration carries the scheduled rate-window cleanup cadence', () => {
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *']);
});

test('native admission bindings use separate public aggregate, public client and owner client namespaces', () => {
  assert.deepEqual(config.ratelimits, [
    { name: 'PUBLIC_ADMISSION_GLOBAL', namespace_id: '1001', simple: { limit: 600, period: 60 } },
    { name: 'PUBLIC_ADMISSION_CLIENT', namespace_id: '1002', simple: { limit: 120, period: 60 } },
    { name: 'OWNER_ADMISSION_CLIENT', namespace_id: '1003', simple: { limit: 30, period: 60 } },
  ]);
});
