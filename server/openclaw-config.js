/* Resolve the local OpenClaw Gateway coordinates + token.

   Two sources, env first:
   1. OPENCLAW_TOKEN / OPENCLAW_URL env vars — supplied by the desktop wizard or
      an operator running the server. This is the realistic path when the gateway
      runs somewhere ~/.openclaw is not readable from (e.g. as root inside WSL).
   2. Fallback: ~/.openclaw/openclaw.json (loopback shared-token install).

   Pure filesystem/parse — no network — so it unit-tests by injecting {env,homeDir}.
   An empty token is allowed (the gateway may run authMode:"none"). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_URL = 'ws://127.0.0.1:18789';

function fromUrl(url, token) {
  let host = '127.0.0.1', port = 18789;
  try { const u = new URL(url); host = u.hostname || host; port = Number(u.port) || port; } catch (e) { /* keep defaults */ }
  return { host, port, token: token || '', url };
}

export function readOpenClawConfig(opts = {}) {
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();

  if (env.OPENCLAW_TOKEN || env.OPENCLAW_URL) {
    return fromUrl(env.OPENCLAW_URL || DEFAULT_URL, env.OPENCLAW_TOKEN);
  }

  const file = path.join(homeDir, '.openclaw', 'openclaw.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('OpenClaw config not found at ' + file + ' and no OPENCLAW_TOKEN/OPENCLAW_URL set '
      + '(is OpenClaw installed, or set OPENCLAW_TOKEN to the gateway token?)');
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error('OpenClaw config at ' + file + ' is not valid JSON: ' + e.message);
  }
  const gw = (cfg && cfg.gateway) || {};
  const auth = gw.auth || {};
  const host = gw.host || '127.0.0.1';
  const port = Number(gw.port) || 18789;
  return { host, port, token: auth.token || '', url: 'ws://' + host + ':' + port };
}
