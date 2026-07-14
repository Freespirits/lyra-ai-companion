/* Fetches the avatar bodies (official VRoid sample models, via the
   madjin/vrm-samples mirror) into public/models/. Run once after cloning:

     node scripts/fetch-assets.mjs

   Mocap clips are NOT fetched: Mixamo's terms require you to download them
   yourself (free Adobe account). See README "Mocap clips" for the list —
   the app runs fine without them on the procedural fallback. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public', 'models');
const BASE = 'https://raw.githubusercontent.com/madjin/vrm-samples/master/';
const MODELS = {
  'lyra.vrm':   'vroid/stable/AvatarSample_B.vrm',
  'nova.vrm':   'vroid/stable/AvatarSample_A.vrm',
  'mira.vrm':   'vroid/stable/AvatarSample_C.vrm',
  'vesper.vrm': 'vroid/beta/Sendagaya_Shino.vrm',
  'kira.vrm':   'vroid/beta/Victoria_Rubin.vrm',
};

fs.mkdirSync(DIR, { recursive: true });
for (const [name, src] of Object.entries(MODELS)) {
  const dst = path.join(DIR, name);
  if (fs.existsSync(dst)) { console.log('skip', name, '(exists)'); continue; }
  process.stdout.write('fetching ' + name + ' ... ');
  const r = await fetch(BASE + src);
  if (!r.ok) { console.log('FAILED ' + r.status); continue; }
  fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  console.log(Math.round(fs.statSync(dst).size / 1048576) + ' MB');
}
console.log('done. Optional: add Mixamo clips to public/animations/ (see README).');
