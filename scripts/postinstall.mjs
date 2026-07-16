/* Runs automatically after `npm install` (package.json "postinstall"), so a fresh
   `git clone && npm install` lands on something runnable instead of a blank config
   and missing avatar bodies. Two jobs:
     1. seed .env from .env.example if there isn't one yet, so the app has a config
        (and doesn't silently fall back to the keyless "anthropic" code default);
     2. download the avatar bodies (delegates to fetch-assets.mjs).
   Both are best-effort and idempotent — never fail the install. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const env = path.join(ROOT, '.env');
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(env) && fs.existsSync(example)) {
    fs.copyFileSync(example, env);
    console.log('[setup] created .env from .env.example — open it to pick your AI provider (the installer does this for you).');
  }
} catch (e) {
  console.log('[setup] could not seed .env: ' + e.message);
}

/* fetch-assets.mjs runs its work at import time (top-level await). */
await import('./fetch-assets.mjs');
