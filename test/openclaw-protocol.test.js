import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METHODS, EVENTS, isChallenge, getNonce, buildConnectFrame, isHelloOk, connectError,
  getSessionKey, getAuthMode, buildSubscribeFrame, buildChatSend, buildAbort,
  isChatEvent, extractChatDelta,
} from '../server/openclaw-protocol.js';

test('recognizes the challenge event and reads its nonce', () => {
  const f = { type: 'event', event: 'connect.challenge', payload: { nonce: 'abc', ts: 1 } };
  assert.equal(isChallenge(f), true);
  assert.equal(getNonce(f), 'abc');
  assert.equal(isChallenge({ type: 'event', event: 'chat' }), false);
});

test('builds an operator connect frame with a PLAINTEXT token (no HMAC)', () => {
  const f = buildConnectFrame({ token: 'tok', id: 'c1' });
  assert.equal(f.type, 'req');
  assert.equal(f.method, METHODS.CONNECT);
  assert.equal(f.params.minProtocol, 4);
  assert.equal(f.params.maxProtocol, 4);
  assert.equal(f.params.role, 'operator');
  assert.deepEqual(f.params.scopes, ['operator.admin']);
  assert.equal(f.params.client.id, 'gateway-client');
  assert.equal(f.params.client.mode, 'backend');
  assert.equal(f.params.auth.token, 'tok');
});

test('omits auth entirely when there is no token (authMode:none)', () => {
  const f = buildConnectFrame({ token: '', id: 'c1' });
  assert.equal('auth' in f.params, false);
});

test('hello-ok / error detection keys off the connect id', () => {
  assert.equal(isHelloOk({ type: 'res', id: 'c1', ok: true, payload: { type: 'hello-ok' } }, 'c1'), true);
  assert.equal(isHelloOk({ type: 'res', id: 'other', ok: true }, 'c1'), false);
  assert.deepEqual(connectError({ type: 'res', id: 'c1', ok: false, error: { message: 'bad token' } }, 'c1'), { message: 'bad token' });
  assert.equal(connectError({ type: 'res', id: 'c1', ok: true }, 'c1'), null);
});

test('pulls sessionKey and authMode from a real-shaped hello-ok', () => {
  const helloOk = { type: 'res', id: 'c1', ok: true, payload: {
    type: 'hello-ok', protocol: 4,
    snapshot: { authMode: 'token', sessionDefaults: { mainSessionKey: 'agent:main:main' } },
  } };
  assert.equal(getSessionKey(helloOk), 'agent:main:main');
  assert.equal(getAuthMode(helloOk), 'token');
});

test('builds subscribe / chat.send / chat.abort frames', () => {
  assert.deepEqual(buildSubscribeFrame({ id: 's', key: 'k' }),
    { type: 'req', id: 's', method: METHODS.SUBSCRIBE, params: { key: 'k' } });
  const send = buildChatSend({ id: 'r', sessionKey: 'k', message: 'hi', idempotencyKey: 'u' });
  assert.equal(send.method, METHODS.CHAT_SEND);
  assert.deepEqual(send.params, { sessionKey: 'k', message: 'hi', idempotencyKey: 'u' });
  assert.deepEqual(buildAbort({ id: 'a', sessionKey: 'k' }),
    { type: 'req', id: 'a', method: METHODS.CHAT_ABORT, params: { sessionKey: 'k' } });
});

test('extractChatDelta parses a delta chat event and marks completion', () => {
  const delta = { type: 'event', event: 'chat', payload: {
    state: 'delta', deltaText: 'Hey ', message: { role: 'assistant', content: [{ type: 'text', text: 'Hey ' }] } } };
  const d = extractChatDelta(delta);
  assert.equal(d.text, 'Hey ');
  assert.equal(d.replace, false);
  assert.equal(d.cumulative, 'Hey ');
  assert.equal(d.terminal, false);

  const fin = { type: 'event', event: 'chat', payload: { state: 'final',
    message: { content: [{ type: 'text', text: 'Hey Ori!' }] } } };
  const f = extractChatDelta(fin);
  assert.equal(f.state, 'final');
  assert.equal(f.terminal, true);
  assert.equal(f.cumulative, 'Hey Ori!');

  assert.equal(extractChatDelta({ type: 'event', event: 'agent', payload: {} }), null);
});

test('isChatEvent only matches the chat event', () => {
  assert.equal(isChatEvent({ type: 'event', event: EVENTS.CHAT }), true);
  assert.equal(isChatEvent({ type: 'event', event: EVENTS.AGENT }), false);
});
