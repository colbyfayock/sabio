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
