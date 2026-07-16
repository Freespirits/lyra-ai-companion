/* Interactive setup wizard — the brain of the one-click installer.
   The per-OS bootstrap scripts (install.command / install.ps1) do the un-scriptable
   parts (ensure Node, download the app, npm install) and then hand off to this,
   which is written ONCE and runs everywhere. It: picks the AI brain + voice +
   hearing, writes .env, guides the prerequisites it can't silently install
   (Ollama, the subscription CLIs), builds the app, and creates a double-click
   launcher. Run from the app directory: `node scripts/setup-wizard.mjs`. */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* ---------- tiny helpers ---------- */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, a => res(a.trim())));
async function choose(title, options, def) {
  console.log('\n' + title);
  options.forEach((o, i) => console.log('  ' + (i + 1) + ') ' + o));
  const a = await ask('Choose [' + def + ']: ');
  const n = parseInt(a || def, 10);
  return (n >= 1 && n <= options.length) ? n : parseInt(def, 10);
}
const c = { b: s => '\x1b[1m' + s + '\x1b[0m', g: s => '\x1b[32m' + s + '\x1b[0m', y: s => '\x1b[33m' + s + '\x1b[0m', d: s => '\x1b[2m' + s + '\x1b[0m' };

function openUrl(url) {
  try {
    if (IS_WIN) spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else if (IS_MAC) spawnSync('open', [url], { stdio: 'ignore' });
    else spawnSync('xdg-open', [url], { stdio: 'ignore' });
  } catch {}
  console.log(c.d('   (opened ' + url + ' — if it did not open, paste it into your browser)'));
}
function has(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

/* Read .env (seeded from .env.example by postinstall) and set KEY=value,
   replacing an existing line or appending. Preserves everything else. */
function loadEnv() {
  if (!fs.existsSync(ENV) && fs.existsSync(EXAMPLE)) fs.copyFileSync(EXAMPLE, ENV);
  return fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
}
function setEnv(text, key, value) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(text) ? text.replace(re, line) : (text.replace(/\s*$/, '') + '\n' + line + '\n');
}

/* ---------- the wizard ---------- */
async function main() {
  console.log(c.b('\n  Lyra setup') + ' — a few quick choices, then she comes alive.\n');
  let env = loadEnv();

  /* 1) THE BRAIN */
  const brain = await choose(c.b('Which AI brain should power Lyra?'), [
    'Ollama' + c.d('  — local + free cloud models, no subscription (recommended)'),
    'OpenClaw' + c.d('  — your own OpenClaw agent is the brain'),
    'Claude' + c.d('  — your Claude subscription (Claude Code CLI)'),
    'ChatGPT' + c.d('  — your ChatGPT subscription (Codex CLI)'),
    'Gemini' + c.d('  — your Google account (Gemini CLI)'),
  ], '1');

  if (brain === 1) {
    env = setEnv(env, 'LLM_PROVIDER', 'ollama');
    env = setEnv(env, 'OLLAMA_MODEL', 'gemma4:cloud');
    if (!has('ollama')) {
      console.log(c.y('\n  Ollama is not installed. I will open the official download page.'));
      console.log('  Install it (double-click the downloaded file), then come back here.');
      openUrl('https://ollama.com/download');
      await ask('  Press Enter once Ollama is installed... ');
    }
    console.log('\n  ' + c.b('One manual step:') + ' open the Ollama app and sign in with your email');
    console.log('  (free, generous limits) so the cloud model works. Then leave Ollama running.');
    await ask('  Press Enter once you are signed in to Ollama... ');
  } else if (brain === 2) {
    env = setEnv(env, 'LLM_PROVIDER', 'openclaw');
    console.log(c.d('\n  Find your token in ~/.openclaw/openclaw.json under gateway.auth.token'));
    const tok = await ask('  Paste your OpenClaw gateway token: ');
    if (tok) env = setEnv(env, 'OPENCLAW_TOKEN', tok);
  } else if (brain === 3) {
    env = setEnv(env, 'LLM_PROVIDER', 'claude-code');
    console.log(c.y('\n  Lyra will use the Claude Code CLI (your subscription, no API key).'));
    console.log('  Install + sign in here, then you are set:');
    openUrl('https://claude.com/claude-code');
    await ask('  Press Enter once the `claude` CLI is installed and signed in... ');
  } else if (brain === 4) {
    env = setEnv(env, 'LLM_PROVIDER', 'codex');
    console.log(c.y('\n  Lyra will use the Codex CLI (your ChatGPT subscription).'));
    openUrl('https://developers.openai.com/codex/cli');
    await ask('  Press Enter once the `codex` CLI is installed and signed in... ');
  } else {
    env = setEnv(env, 'LLM_PROVIDER', 'gemini-cli');
    console.log(c.y('\n  Lyra will use the Gemini CLI (your Google account).'));
    openUrl('https://github.com/google-gemini/gemini-cli');
    await ask('  Press Enter once the `gemini` CLI is installed and signed in... ');
  }

  /* 2) VOICE (TTS) */
  const voice = await choose(c.b('Lyra\'s voice?'), [
    'Free' + c.d('  — built-in neural voices, no account'),
    'ElevenLabs' + c.d('  — best, a real emotional voice per character (free key)'),
  ], '1');
  if (voice === 2) {
    console.log(c.y('\n  Get a free ElevenLabs API key here:'));
    openUrl('https://elevenlabs.io/app/settings/api-keys');
    const key = await ask('  Paste your ElevenLabs API key (or Enter to skip): ');
    if (key) { env = setEnv(env, 'TTS_PROVIDER', 'elevenlabs'); env = setEnv(env, 'ELEVENLABS_API_KEY', key); }
    else env = setEnv(env, 'TTS_PROVIDER', 'edge');
  } else {
    env = setEnv(env, 'TTS_PROVIDER', 'edge');
  }

  /* 3) HEARING (STT) */
  const hear = await choose(c.b('Understanding your speech (for voice calls)?'), [
    'Free' + c.d('  — browser speech recognition (Chrome/Edge)'),
    'Deepgram' + c.d('  — highest accuracy (free key)'),
  ], '1');
  if (hear === 2) {
    console.log(c.y('\n  Get a free Deepgram API key here:'));
    openUrl('https://console.deepgram.com/signup');
    const key = await ask('  Paste your Deepgram API key (or Enter to skip): ');
    if (key) env = setEnv(env, 'DEEPGRAM_API_KEY', key);
  }

  /* sensible defaults */
  env = setEnv(env, 'LYRA_GUARD', 'off');
  env = setEnv(env, 'PORT', '8686');
  fs.writeFileSync(ENV, env);
  console.log(c.g('\n  Saved your choices to .env'));

  rl.close();

  /* 4) BUILD */
  console.log('\n  Building the app (one moment)...');
  const npm = IS_WIN ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) console.log(c.y('  Build had a problem — you can still run it, tell whoever set this up.'));

  /* 5) LAUNCHER (double-click to open Lyra any time) */
  const launcher = makeLauncher();
  console.log(c.g('\n  Created a launcher: ') + c.b(launcher));

  console.log(c.b('\n  Done!') + ' Lyra is installed.');
  console.log('  • Double-click ' + c.b(path.basename(launcher)) + ' any time to open her.');
  console.log('  • She opens in your browser at ' + c.b('http://localhost:8686'));
  console.log(c.d('  • Voice calls need Chrome or Edge.\n'));
}

/* Write a platform-appropriate double-click launcher that runs the single-port
   production server and opens the browser. Returns its path. */
function makeLauncher() {
  if (IS_WIN) {
    const p = path.join(ROOT, 'Lyra.bat');
    fs.writeFileSync(p,
      '@echo off\r\n' +
      'cd /d "%~dp0"\r\n' +
      'start "" http://localhost:8686\r\n' +
      'node server/index.js\r\n');
    return p;
  }
  const name = IS_MAC ? 'Lyra.command' : 'lyra-start.sh';
  const p = path.join(ROOT, name);
  const opener = IS_MAC ? 'open' : 'xdg-open';
  fs.writeFileSync(p,
    '#!/bin/bash\n' +
    'cd "$(dirname "$0")"\n' +
    '( sleep 2 && ' + opener + ' http://localhost:8686 ) &\n' +
    'node server/index.js\n');
  try { fs.chmodSync(p, 0o755); } catch {}
  return p;
}

main().catch(e => { console.error('\n  Setup error: ' + e.message); try { rl.close(); } catch {} process.exit(0); });
