/* PURE OpenClaw v4 operator-protocol frame logic — no I/O, no `ws`.
   Every wire name below is LIVE-VERIFIED against OpenClaw v2026.7.1 (see
   docs/superpowers/specs/2026-07-14-openclaw-protocol-verified.md). Frame
   envelopes: event = {type:'event',event,payload,seq}; response =
   {type:'res',id,ok,payload?,error?}; request = {type:'req',id,method,params}. */

export const EVENTS = { CHALLENGE: 'connect.challenge', CHAT: 'chat', AGENT: 'agent' };
export const METHODS = {
  CONNECT: 'connect',
  SUBSCRIBE: 'sessions.messages.subscribe',
  CHAT_SEND: 'chat.send',
  CHAT_ABORT: 'chat.abort',
};
/* chat-event lifecycle states (payload.state) */
export const TERMINAL_STATES = ['final', 'aborted', 'error'];

export function isChallenge(frame) {
  return !!frame && frame.type === 'event' && frame.event === EVENTS.CHALLENGE;
}

/* nonce is only needed if you attach an optional Ed25519 device signature;
   a shared-token operator does not, but expose it for completeness. */
export function getNonce(frame) {
  return (frame && frame.payload && frame.payload.nonce) || null;
}

/* The operator connect frame. Token travels PLAINTEXT in params.auth.token
   (no HMAC). auth is omitted entirely when there is no token (authMode:none). */
export function buildConnectFrame({
  token, id, clientId = 'gateway-client', mode = 'backend',
  version = '0.0.0', platform = process.platform,
  role = 'operator', scopes = ['operator.admin'],
}) {
  return {
    type: 'req', id, method: METHODS.CONNECT,
    params: {
      minProtocol: 4, maxProtocol: 4,
      client: { id: clientId, version, platform, mode },
      caps: [], role, scopes,
      ...(token ? { auth: { token } } : {}),
    },
  };
}

/* hello-ok is the response to the connect request. */
export function isHelloOk(frame, connectId) {
  return !!frame && frame.type === 'res' && frame.id === connectId && frame.ok === true;
}
export function connectError(frame, connectId) {
  if (frame && frame.type === 'res' && frame.id === connectId && frame.ok === false) return frame.error || { message: 'connect rejected' };
  return null;
}
export function getSessionKey(helloOk) {
  return (helloOk && helloOk.payload && helloOk.payload.snapshot
    && helloOk.payload.snapshot.sessionDefaults
    && helloOk.payload.snapshot.sessionDefaults.mainSessionKey) || null;
}
export function getAuthMode(helloOk) {
  return (helloOk && helloOk.payload && helloOk.payload.snapshot && helloOk.payload.snapshot.authMode) || null;
}

export function buildSubscribeFrame({ id, key }) {
  return { type: 'req', id, method: METHODS.SUBSCRIBE, params: { key } };
}
export function buildChatSend({ id, sessionKey, message, idempotencyKey }) {
  return { type: 'req', id, method: METHODS.CHAT_SEND, params: { sessionKey, message, idempotencyKey } };
}
export function buildAbort({ id, sessionKey }) {
  return { type: 'req', id, method: METHODS.CHAT_ABORT, params: { sessionKey } };
}

export function isChatEvent(frame) {
  return !!frame && frame.type === 'event' && frame.event === EVENTS.CHAT;
}

/* Turn a chat event into a render instruction. The incremental text to speak is
   payload.deltaText; when payload.replace is true, reset the buffer to the
   cumulative snapshot at payload.message.content[0].text instead of appending.
   payload.state marks the lifecycle; TERMINAL_STATES end the turn. */
export function extractChatDelta(frame) {
  if (!isChatEvent(frame)) return null;
  const p = frame.payload || {};
  const cumulative = p.message && p.message.content && p.message.content[0] && p.message.content[0].text;
  return {
    text: typeof p.deltaText === 'string' ? p.deltaText : '',
    replace: p.replace === true,
    cumulative: typeof cumulative === 'string' ? cumulative : null,
    state: p.state || null,
    terminal: TERMINAL_STATES.includes(p.state),
  };
}
