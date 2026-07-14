import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moderateWithModel, guardModelName } from '../server/guard-model.js';

test('guardModelName respects GUARD_MODEL and the LYRA_GUARD off switch', () => {
  assert.equal(guardModelName({ GUARD_MODEL: 'llama-guard3:1b' }), 'llama-guard3:1b');
  assert.equal(guardModelName({ GUARD_MODEL: 'x', LYRA_GUARD: 'off' }), '');
  assert.equal(guardModelName({}), '');
});

test('moderateWithModel is a no-op when no model is configured', async () => {
  const r = await moderateWithModel('u', 'r', { env: {} });
  assert.equal(r.checked, false);
  assert.equal(r.blocked, false);
});

test('moderateWithModel parses SAFE / UNSAFE from the classifier', async () => {
  const mkFetch = reply => async () => ({ ok: true, json: async () => ({ message: { content: reply } }) });
  const env = { GUARD_MODEL: 'llama-guard3:1b' };
  assert.equal((await moderateWithModel('u', 'flirty', { env, fetch: mkFetch('safe') })).blocked, false);
  assert.equal((await moderateWithModel('u', 'x', { env, fetch: mkFetch('unsafe\nS12') })).blocked, true);
  assert.equal((await moderateWithModel('u', 'x', { env, fetch: mkFetch('UNSAFE') })).blocked, true);
});

test('moderateWithModel is DEFAULT-DENY: empty/garbled/refusal output blocks (fail-closed)', async () => {
  const mkFetch = reply => async () => ({ ok: true, json: async () => ({ message: { content: reply } }) });
  const env = { GUARD_MODEL: 'llama-guard3:1b' };
  for (const junk of ['', '   ', 'I cannot classify that', 'hello', 'maybe', 'the reply seems fine']) {
    assert.equal((await moderateWithModel('u', 'x', { env, fetch: mkFetch(junk) })).blocked, true, JSON.stringify(junk));
  }
  assert.equal((await moderateWithModel('u', 'x', { env, fetch: mkFetch('safe') })).blocked, false);
});

test('moderateWithModel throws on http error so the caller can fail-closed', async () => {
  const env = { GUARD_MODEL: 'llama-guard3:1b' };
  await assert.rejects(() => moderateWithModel('u', 'r', { env, fetch: async () => ({ ok: false, status: 500 }) }));
});
