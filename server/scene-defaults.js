/* Built-in scene definitions, shared by the server (live /api/scenes) and by
   scripts/gen-manifests.mjs (baked manifest for the mobile app bundle). */
export const DEFAULT_SCENES = [
  { name: 'violet-dream', label: 'Violet Dream', procedural: { kind: 'aurora', top: '#2a2050', mid: '#161129', bottom: '#0b0817', stars: .55, glow: '#a78bfa' }, lighting: { key: ['#ffffff', .38], rim: ['#7de3d8', .14], amb: ['#bfb8ff', .22] } },
  { name: 'sunset-beach', label: 'Sunset Beach', procedural: { top: '#40295e', mid: '#e0705a', bottom: '#2a1a2e', stars: .1,  glow: '#ffd166' }, lighting: { key: ['#ffc98a', .42], rim: ['#ff8e5e', .16], amb: ['#d8a8c8', .22] } },
  { name: 'night-city',   label: 'Night City',   yaw: 180, procedural: { top: '#0a0e1f', mid: '#151d3a', bottom: '#05070f', stars: .85, glow: '#5e8eff' }, lighting: { key: ['#cfe0ff', .34], rim: ['#5e8eff', .18], amb: ['#8fa3d8', .20] } },
  { name: 'cosmos',       label: 'Cosmos',       procedural: { kind: 'nebula', top: '#0a0316', mid: '#170a33', bottom: '#03010a', stars: 1,   glow: '#c17bff' }, lighting: { key: ['#e6d8ff', .34], rim: ['#c17bff', .18], amb: ['#9a86d8', .20] } },
];

/* pure function used by both sides: merge defaults + files on disk + scenes.json */
export function buildSceneList(files, manifestJson) {
  const scenes = DEFAULT_SCENES.map(s => ({ ...s }));
  for (const f of files) {
    const isImg = /\.(jpe?g|png|webp)$/i.test(f), isVid = /\.(mp4|webm)$/i.test(f);
    if (!isImg && !isVid) continue;
    const name = f.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, '-');
    const existing = scenes.find(s => s.name === name);
    const entry = existing || scenes[scenes.push({ name, label: name.replace(/-/g, ' ') }) - 1];
    if (isVid) entry.video = '/scenes/' + f;
    else entry.image = '/scenes/' + f;
  }
  for (const m of manifestJson || []) {
    const i = scenes.findIndex(s => s.name === m.name);
    if (i > -1) scenes[i] = { ...scenes[i], ...m };
    else scenes.push(m);
  }
  return scenes;
}
