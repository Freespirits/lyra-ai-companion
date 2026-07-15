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
/* A value is either a path under BASE (the VRoid samples) or an absolute URL. */
const MODELS = {
  'lyra.vrm':   'vroid/stable/AvatarSample_B.vrm',
  'nova.vrm':   'vroid/stable/AvatarSample_A.vrm',
  'mira.vrm':   'vroid/stable/AvatarSample_C.vrm',
  'vesper.vrm': 'vroid/beta/Sendagaya_Shino.vrm',
  'kira.vrm':   'vroid/beta/Victoria_Rubin.vrm',
  /* Bao the panda. No panda VRM exists under an open license anywhere — the
     closest is a paid, non-redistributable Booth model. This is "Teddy" by
     Polygonal Mind (Open Source Avatars): CC0, allowedUser Everyone, a 52-bone
     VRM humanoid with every Mixamo-critical bone present, and a round upright
     bear — the right silhouette for an old kung fu master. It arrives brown;
     recoloring the single 1024x1024 albedo to panda markings is a texture edit,
     which CC0 explicitly permits. */
  'bao.vrm':    'https://arweave.net/KbaYR3YmtjweLgEcJAWekeh3MNAlF9ZWOYJkbNfi8MM',
};

fs.mkdirSync(DIR, { recursive: true });
for (const [name, src] of Object.entries(MODELS)) {
  const dst = path.join(DIR, name);
  if (fs.existsSync(dst)) { console.log('skip', name, '(exists)'); continue; }
  process.stdout.write('fetching ' + name + ' ... ');
  const r = await fetch(/^https?:\/\//.test(src) ? src : BASE + src);
  if (!r.ok) { console.log('FAILED ' + r.status); continue; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.toString('utf8', 0, 4) !== 'glTF') {   /* a 404 page would sail through otherwise */
    console.log('FAILED — not a VRM/glTF (got ' + buf.length + ' bytes)');
    continue;
  }
  fs.writeFileSync(dst, buf);
  console.log((fs.statSync(dst).size / 1048576).toFixed(1) + ' MB');
}
console.log('done. Optional: add Mixamo clips to public/animations/ (see README).');
