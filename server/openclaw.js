/* Stateful operator connection to the local OpenClaw Gateway + the streamOpenClaw
   provider. This is the ONLY file that opens a socket (`ws` as a CLIENT, like
   server/stt.js reaches Deepgram). It keeps one long-lived operator connection
   and feeds the agent's streamed reply into the SAME onDelta(text) callback the
   LLM streamers use, so segmenting/TTS/lip-sync/captions run unchanged. The
   user's OpenClaw agent owns the brain/memory/tools — we never call an LLM here.
   Protocol shapes are all in server/openclaw-protocol.js (live-verified). */
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import { readOpenClawConfig } from './openclaw-config.js';
import {
  isChallenge, buildConnectFrame, isHelloOk, connectError, getSessionKey, getAuthMode,
  buildSubscribeFrame, buildChatSend, buildAbort, isChatEvent, extractChatDelta,
} from './openclaw-protocol.js';
import { guardModelName, moderateWithModel } from './guard-model.js';
import { DEFLECTION } from './guard.js';

const CONNECT_TIMEOUT_MS = 10000;

export class OpenClawClient {
  constructor(opts = {}) {
    this.cfg = opts.cfg || readOpenClawConfig(opts);
    this.ws = null;
    this.ready = false;
    this.sessionKey = null;
    this.authMode = null;
    this._connectId = null;
    this._chatHandlers = new Set();
    this._subscribed = false;
    this._connectPromise = null;
  }

  onChat(fn) { this._chatHandlers.add(fn); return () => this._chatHandlers.delete(fn); }
  _send(f) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f)); }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.cfg.url);
      this.ws = ws;
      this._connectId = crypto.randomUUID();
      let settled = false;
      const done = err => {
        if (settled) return; settled = true; clearTimeout(timer);
        this._connectPromise = null;
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} done(new Error('OpenClaw connect timeout')); }, CONNECT_TIMEOUT_MS);

      ws.on('message', raw => {
        let f; try { f = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
        if (isChallenge(f)) { this._send(buildConnectFrame({ token: this.cfg.token, id: this._connectId })); return; }
        const err = connectError(f, this._connectId);
        if (err) { try { ws.close(); } catch (e) {} return done(new Error('OpenClaw connect rejected: ' + (err.message || err.code || 'unknown'))); }
        if (!this.ready && isHelloOk(f, this._connectId)) {
          this.ready = true;
          this.sessionKey = getSessionKey(f);
          this.authMode = getAuthMode(f);
          this._subscribed = false;
          this.subscribe();
          return done();
        }
        if (isChatEvent(f)) {
          const d = extractChatDelta(f);
          if (d) for (const fn of this._chatHandlers) { try { fn(d, f); } catch (e) {} }
        }
      });
      ws.on('error', e => done(new Error('OpenClaw ws error: ' + e.message)));
      ws.on('close', () => { this.ready = false; this._subscribed = false; });
    });
    return this._connectPromise;
  }

  subscribe() {
    if (this._subscribed || !this.sessionKey) return;
    this._subscribed = true;
    this._send(buildSubscribeFrame({ id: crypto.randomUUID(), key: this.sessionKey }));
  }

  sendTurn(text) {
    this._send(buildChatSend({ id: crypto.randomUUID(), sessionKey: this.sessionKey, message: text, idempotencyKey: crypto.randomUUID() }));
  }

  abort() { if (this.sessionKey) this._send(buildAbort({ id: crypto.randomUUID(), sessionKey: this.sessionKey })); }
  close() { this.ready = false; try { if (this.ws) this.ws.close(); } catch (e) {} }
}

/* Most recent user turn's text (content may be a string or media block array). */
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
    }
  }
  return '';
}

let _shared = null;
export function getSharedClient(opts = {}) { if (!_shared) _shared = new OpenClawClient(opts); return _shared; }
export function resetSharedClient() { if (_shared) { try { _shared.close(); } catch (e) {} } _shared = null; }

/* Drop-in streamer, same contract as streamOllama/streamAnthropic:
   (messages, ac, onDelta, system|opts) -> Promise. `system` is ignored — the
   OpenClaw agent owns persona/brain. Feeds the agent's streamed reply into
   onDelta and resolves when the turn reaches a terminal state. */
export async function streamOpenClaw(messages, ac, onDelta, opts = {}) {
  const client = (opts && opts.client) || getSharedClient(typeof opts === 'object' ? opts : {});
  if (!client.ready) await client.connect();
  const text = lastUserText(messages);
  /* When a model guard is configured we buffer the whole reply, classify it, and
     only then speak it (or a deflection) — so nothing explicit is voiced mid-stream.
     Without a model guard we stream live as before. */
  const modelGuard = !!guardModelName();

  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let detach = () => {};
    let onAbort = null;
    const finish = err => {
      if (settled) return; settled = true;
      detach();
      if (onAbort) ac.signal.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve();
    };
    onAbort = () => { try { client.abort(); } catch (e) {} finish(new Error('interrupted')); };
    if (ac.signal.aborted) return finish(new Error('interrupted'));
    ac.signal.addEventListener('abort', onAbort, { once: true });

    const flushGuarded = async () => {
      let blocked = false;
      try {
        const gac = new AbortController();
        const timer = setTimeout(() => gac.abort(), 20000);
        const m = await moderateWithModel(text, buf, { signal: gac.signal });
        clearTimeout(timer);
        blocked = m.blocked;
      } catch (e) {
        blocked = true;                 /* fail-closed: never leak past a broken guard */
      }
      if (settled || ac.signal.aborted) return;
      onDelta(blocked ? DEFLECTION : buf);
      finish();
    };

    detach = client.onChat((d, f) => {
      /* ignore the user's own echoed message if it ever surfaces as a chat event */
      if (f && f.payload && f.payload.message && f.payload.message.role === 'user') return;
      let inc = '';
      if (d.text) inc = d.text;
      else if (d.cumulative != null && d.cumulative.startsWith(buf)) inc = d.cumulative.slice(buf.length);
      if (inc) { buf += inc; if (!modelGuard) onDelta(inc); }
      if (d.terminal) {
        if (d.state === 'error') return finish(new Error('openclaw run error'));
        if (modelGuard) { flushGuarded(); return; }
        return finish();
      }
    });

    client.sendTurn(text);
  });
}
