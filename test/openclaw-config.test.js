import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOpenClawConfig } from '../server/openclaw-config.js';

function tmpHome(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
  fs.mkdirSync(path.join(dir, '.openclaw'), { recursive: true });
  if (json !== undefined) fs.writeFileSync(path.join(dir, '.openclaw', 'openclaw.json'), json);
  return dir;
}

test('env OPENCLAW_TOKEN/URL take precedence over any file', () => {
  const home = tmpHome(JSON.stringify({ gateway: { port: 5, auth: { token: 'fromfile' } } }));
  const c = readOpenClawConfig({ env: { OPENCLAW_TOKEN: 'envtok', OPENCLAW_URL: 'ws://127.0.0.1:9000' }, homeDir: home });
  assert.equal(c.token, 'envtok');
  assert.equal(c.url, 'ws://127.0.0.1:9000');
  assert.equal(c.port, 9000);
  assert.equal(c.host, '127.0.0.1');
});

test('env token alone uses the default gateway url', () => {
  const c = readOpenClawConfig({ env: { OPENCLAW_TOKEN: 'envtok' }, homeDir: '/nonexistent' });
  assert.equal(c.token, 'envtok');
  assert.equal(c.url, 'ws://127.0.0.1:18789');
  assert.equal(c.port, 18789);
});

test('falls back to the config file when no env', () => {
  const home = tmpHome(JSON.stringify({ gateway: { auth: { token: 'abc123' } } }));
  const c = readOpenClawConfig({ env: {}, homeDir: home });
  assert.equal(c.token, 'abc123');
  assert.equal(c.port, 18789);
  assert.equal(c.url, 'ws://127.0.0.1:18789');
});

test('honors explicit host/port in the file', () => {
  const home = tmpHome(JSON.stringify({ gateway: { host: '127.0.0.1', port: 9999, auth: { token: 't' } } }));
  const c = readOpenClawConfig({ env: {}, homeDir: home });
  assert.equal(c.port, 9999);
  assert.equal(c.url, 'ws://127.0.0.1:9999');
});

test('throws when neither env nor a config file provides anything', () => {
  const home = tmpHome(undefined);
  assert.throws(() => readOpenClawConfig({ env: {}, homeDir: home }), /OpenClaw/);
});
