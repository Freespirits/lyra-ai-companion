#!/usr/bin/env node
/* create-lyra — one command to install Lyra, on any OS:
 *
 *     npx create-lyra            # installs to ~/Lyra
 *     npx create-lyra ./my-lyra  # installs to a folder you name
 *
 * Node is already present (you're running it), so this just: downloads the app
 * (git if available, else a tarball via `tar`), runs `npm install` (which fetches
 * the avatar bodies and seeds .env), then hands off to the interactive setup
 * wizard (AI brain / voice / hearing + a double-click launcher). It's the same
 * flow as install.command / install.ps1, in one cross-platform command. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = 'https://github.com/Freespirits/lyra-ai-companion';
const IS_WIN = process.platform === 'win32';
const say = s => console.log('  ' + s);
const have = c => spawnSync(IS_WIN ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });

async function main() {
  console.log('\n  Lyra — installing a talking, 3D avatar companion.\n');

  const maj = parseInt(process.versions.node.split('.')[0], 10);
  if (maj < 20) { say('Node 20+ is required (you have ' + process.versions.node + '). Update Node and retry.'); process.exit(1); }

  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.homedir(), 'Lyra');

  // 1) download / update
  if (fs.existsSync(path.join(dir, '.git'))) {
    say('Updating your existing install at ' + dir + ' ...');
    run('git', ['pull', '--ff-only'], { cwd: dir });
  } else if (fs.existsSync(dir)) {
    say('Using the existing folder ' + dir);
  } else {
    say('Downloading Lyra to ' + dir + ' ...');
    if (have('git')) {
      const c = run('git', ['clone', '--depth', '1', REPO + '.git', dir]);
      if (c.status !== 0) { say('git clone failed.'); process.exit(1); }
    } else {
      const parent = path.dirname(dir);
      fs.mkdirSync(parent, { recursive: true });
      const tgz = path.join(os.tmpdir(), 'lyra-' + process.pid + '.tar.gz');
      const res = await fetch(REPO + '/archive/refs/heads/main.tar.gz');
      if (!res.ok) { say('Download failed (HTTP ' + res.status + ').'); process.exit(1); }
      fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
      const ex = run('tar', ['-xzf', tgz, '-C', parent]);          // tar ships on Win10+/macOS/Linux
      if (ex.status !== 0) { say('Extract failed — install git and retry.'); process.exit(1); }
      fs.renameSync(path.join(parent, 'lyra-ai-companion-main'), dir);
      try { fs.unlinkSync(tgz); } catch {}
    }
  }

  // 2) install (postinstall fetches the bodies + seeds .env)
  console.log('');
  say('Installing — this also downloads her bodies (~75 MB), about a minute...');
  const inst = run('npm', ['install'], { cwd: dir, shell: IS_WIN });
  if (inst.status !== 0) say('npm install reported a problem (see above) — you can re-run it in ' + dir + '.');

  // 3) interactive setup: brain / voice / hearing + build + launcher
  run('node', ['scripts/setup-wizard.mjs'], { cwd: dir });
}

main().catch(e => { console.error('\n  Install error: ' + e.message); process.exit(1); });
