/* Throwaway live confirmation of the source-verified OpenClaw v4 operator
   protocol. Token comes from OPENCLAW_TOKEN (never hardcoded). Raw frames go to
   server/.scratch/ (gitignored) with the token redacted. Delete after use. */
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.OPENCLAW_TOKEN || '';
const url = process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789';
const scratch = path.resolve('server', '.scratch');
fs.mkdirSync(scratch, { recursive: true });
const logFile = path.join(scratch, 'openclaw-raw.log');
fs.writeFileSync(logFile, '# spike ' + new Date().toISOString() + ' -> ' + url + '\n');
const redact = o => JSON.parse(JSON.stringify(o, (k, v) => (k === 'token' ? '<redacted>' : v)));
const log = (dir, o) => {
  const line = dir + ' ' + JSON.stringify(redact(o));
  fs.appendFileSync(logFile, line + '\n');
  console.log(line.slice(0, 420));
};

const connectId = crypto.randomUUID();
let sessionKey = null, assembled = '', done = false;
const ws = new WebSocket(url);
const send = f => { log('SEND', f); ws.send(JSON.stringify(f)); };

ws.on('open', () => console.log('OPEN ' + url));
ws.on('message', raw => {
  let f; try { f = JSON.parse(raw.toString('utf8')); } catch { return; }

  if (f.event === 'connect.challenge') {
    log('RECV', f);
    send({
      type: 'req', id: connectId, method: 'connect',
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: 'gateway-client', version: '0.0.0', platform: process.platform, mode: 'backend' },
        caps: [], role: 'operator', scopes: ['operator.admin'],
        ...(token ? { auth: { token } } : {}),
      },
    });
    return;
  }

  if (f.type === 'res' && f.id === connectId) {
    const s = f.payload && f.payload.snapshot;
    log('RECV-helloOk', {
      ok: f.ok, protocol: f.payload && f.payload.protocol,
      serverVersion: f.payload && f.payload.server && f.payload.server.version,
      authMode: s && s.authMode,
      mainSessionKey: s && s.sessionDefaults && s.sessionDefaults.mainSessionKey,
      error: f.error,
    });
    if (!f.ok) { console.log('CONNECT FAILED: ' + JSON.stringify(f.error)); ws.close(); return; }
    sessionKey = s && s.sessionDefaults && s.sessionDefaults.mainSessionKey;
    send({ type: 'req', id: crypto.randomUUID(), method: 'sessions.messages.subscribe', params: { key: sessionKey } });
    send({ type: 'req', id: crypto.randomUUID(), method: 'chat.send',
      params: { sessionKey, message: 'Say hello back to me in one short friendly sentence.', idempotencyKey: crypto.randomUUID() } });
    return;
  }

  if (f.event === 'chat') {
    const p = f.payload || {};
    if (typeof p.deltaText === 'string') {
      if (p.replace) assembled = (p.message && p.message.content && p.message.content[0] && p.message.content[0].text) || p.deltaText;
      else assembled += p.deltaText;
    }
    if (p.state && p.state !== 'delta') log('CHAT-STATE', { state: p.state, len: assembled.length });
    if (p.state === 'final' || p.state === 'error' || p.state === 'aborted') {
      done = true;
      console.log('\n=== ASSISTANT REPLY (' + p.state + ') ===\n' + assembled.slice(0, 600) + '\n=== END ===');
      setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 250);
    }
    return;
  }

  if (f.event && f.event !== 'tick') log('RECV-evt', { event: f.event, seq: f.seq });
});

ws.on('error', e => console.log('WS ERROR: ' + e.message));
ws.on('close', c => console.log('CLOSE ' + c));
setTimeout(() => { console.log('TIMEOUT after 35s; gotFinal=' + done); try { ws.close(); } catch {} process.exit(0); }, 35000);
