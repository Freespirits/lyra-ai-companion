/* Gives Bao a face. The Teddy body (CC0, VRM 0.0) ships with exactly six
   blendShapeGroups — a e i o u blink — so the app's whole facial layer
   (src/avatar.js EMO_EXPR happy/sad/angry/relaxed/surprised, and the wink
   gesture which needs blinkLeft) is inert on him.

   Two fixes, both inside the GLB, no dependencies:

   1. Synthesize blink_l / blink_r as REAL new morph targets by masking the
      existing whole-face 'blink' morph's deltas by which side of the head
      each vertex sits on (sign of the base-mesh X coordinate).

   2. Add VRM 0.0 blendShapeGroups that sculpt emotions out of the six
      shapes that exist. three-vrm maps VRM0 preset names to VRM1 ones
      (verified in @pixiv/three-vrm-core v0v1PresetNameMap):
        joy -> happy, sorrow -> sad, angry -> angry, fun -> relaxed,
        blink_l -> blinkLeft, blink_r -> blinkRight,
      and a group with presetName 'unknown' becomes a CUSTOM expression
      named by its `name` field — used here for 'surprised' (lowercase,
      exactly what src/avatar.js exprAvail.has('surprised') checks).

   Runs from fetch-assets.mjs after the panda repaint. Idempotent: if a
   blink_l group already exists the buffer is returned unchanged. */

const F32 = 5126;

/* ---------- accessor decode (dense or sparse) ---------- */
/* Morph-target accessors are allowed to be sparse (and some exporters emit
   them that way), so everything is decoded to a dense Float32Array first.
   Only VEC3/float32 is supported — that is what POSITION/NORMAL deltas are. */
function readVec3(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  if (acc.type !== 'VEC3' || acc.componentType !== F32) {
    throw new Error(`accessor ${accIdx}: expected VEC3 float32, got ${acc.type}/${acc.componentType}`);
  }
  const out = new Float32Array(acc.count * 3);
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || 12;
    for (let i = 0; i < acc.count; i++) {
      const o = base + i * stride;
      out[i * 3]     = bin.readFloatLE(o);
      out[i * 3 + 1] = bin.readFloatLE(o + 4);
      out[i * 3 + 2] = bin.readFloatLE(o + 8);
    }
  }
  if (acc.sparse) {
    const s = acc.sparse;
    const ibv = json.bufferViews[s.indices.bufferView];
    const ioff = (ibv.byteOffset || 0) + (s.indices.byteOffset || 0);
    const readIdx =
      s.indices.componentType === 5121 ? i => bin.readUInt8(ioff + i) :
      s.indices.componentType === 5123 ? i => bin.readUInt16LE(ioff + i * 2) :
      s.indices.componentType === 5125 ? i => bin.readUInt32LE(ioff + i * 4) :
      null;
    if (!readIdx) throw new Error(`accessor ${accIdx}: bad sparse index componentType`);
    const vbv = json.bufferViews[s.values.bufferView];
    const voff = (vbv.byteOffset || 0) + (s.values.byteOffset || 0);
    for (let i = 0; i < s.count; i++) {
      const v = readIdx(i);
      out[v * 3]     = bin.readFloatLE(voff + i * 12);
      out[v * 3 + 1] = bin.readFloatLE(voff + i * 12 + 4);
      out[v * 3 + 2] = bin.readFloatLE(voff + i * 12 + 8);
    }
  }
  return out;
}

/* Which sign of X is the character's LEFT? VRM 0.0 models face Z-, which
   puts the left side at X- — but rather than trust the convention, read it
   off the humanoid rig: walk the leftUpperArm node's parent chain summing
   translations (rest pose, rotations are identity) and take the sign. */
function leftSideSign(json) {
  try {
    const bones = json.extensions.VRM.humanoid.humanBones;
    const node = bones.find(b => b.bone === 'leftUpperArm').node;
    const parent = {};
    json.nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
    let x = 0;
    for (let cur = node; cur !== undefined; cur = parent[cur]) {
      x += (json.nodes[cur].translation || [0, 0, 0])[0];
    }
    if (x !== 0) return Math.sign(x);
  } catch { /* fall through to the VRM0 convention */ }
  return -1;
}

export function addExpressions(glb) {
  if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  const binHeader = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binHeader);
  const bin = glb.slice(binHeader + 8, binHeader + 8 + binLen);

  const vrm = json.extensions && json.extensions.VRM;
  if (!vrm || !vrm.blendShapeMaster) throw new Error('not a VRM 0.0 file');
  const groups = vrm.blendShapeMaster.blendShapeGroups || (vrm.blendShapeMaster.blendShapeGroups = []);

  /* idempotent: fetch-assets may be re-run over an already-processed file */
  if (groups.some(g => g.presetName === 'blink_l')) return glb;

  const groupOf = preset => groups.find(g => g.presetName === preset);
  const blinkGroup = groupOf('blink');
  if (!blinkGroup || !blinkGroup.binds || !blinkGroup.binds.length) {
    throw new Error("no 'blink' blendShapeGroup to split into blink_l/blink_r");
  }
  /* morph index of a preset's shape within a given mesh */
  const morphIndexFor = (preset, meshIdx) => {
    const g = groupOf(preset);
    const b = g && (g.binds || []).find(b2 => b2.mesh === meshIdx);
    if (!b) throw new Error(`preset '${preset}' has no bind on mesh ${meshIdx}`);
    return b.index;
  };

  const leftSign = leftSideSign(json);

  /* ---------- BIN append machinery (4-byte aligned, dense, little-endian) */
  const chunks = [bin];
  let curLen = bin.length;
  const align4 = () => {
    const pad = (4 - (curLen % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); curLen += pad; }
  };
  /* New accessors are written DENSE. min/max on POSITION is required by the
     glTF spec (morph POSITION accessors included) and computed from the
     actual masked data — zeros are real values there, so they count. */
  const appendVec3Accessor = (f32, withMinMax) => {
    align4();
    const buf = Buffer.alloc(f32.length * 4);
    for (let i = 0; i < f32.length; i++) buf.writeFloatLE(f32[i], i * 4);
    json.bufferViews.push({ buffer: 0, byteOffset: curLen, byteLength: buf.length });
    chunks.push(buf); curLen += buf.length;
    const acc = {
      bufferView: json.bufferViews.length - 1,
      componentType: F32, count: f32.length / 3, type: 'VEC3',
    };
    if (withMinMax) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < f32.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          if (f32[i + c] < mn[c]) mn[c] = f32[i + c];
          if (f32[i + c] > mx[c]) mx[c] = f32[i + c];
        }
      }
      acc.min = mn; acc.max = mx;
    }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };

  /* ---------- 1. split 'blink' into blink_l / blink_r per bound mesh ---- */
  /* Records [meshIdx, newLeftTargetIndex, newRightTargetIndex] */
  const newTargets = [];
  for (const bind of blinkGroup.binds) {
    const mesh = json.meshes[bind.mesh];
    /* Per glTF spec every primitive of a mesh has the same target count, so
       the two new targets land at the same indices in each primitive. */
    const baseCount = mesh.primitives[0].targets.length;
    for (const prim of mesh.primitives) {
      if (!prim.targets || prim.targets.length !== baseCount) {
        throw new Error(`mesh ${bind.mesh}: primitives disagree on target count`);
      }
      const basePos = readVec3(json, bin, prim.attributes.POSITION);
      const src = prim.targets[bind.index];
      const dPos = readVec3(json, bin, src.POSITION);
      const dNrm = src.NORMAL !== undefined ? readVec3(json, bin, src.NORMAL) : null;
      const nVerts = basePos.length / 3;
      if (dPos.length !== basePos.length) {
        throw new Error(`mesh ${bind.mesh}: blink morph vertex count mismatch`);
      }
      /* Mask by side. Vertices exactly on the seam (x === 0) go to the
         right half so the delta is never applied twice when both eyes
         close together; on this mesh no blink-moved vertex sits at x=0. */
      const lPos = new Float32Array(dPos.length), rPos = new Float32Array(dPos.length);
      const lNrm = dNrm && new Float32Array(dNrm.length), rNrm = dNrm && new Float32Array(dNrm.length);
      for (let v = 0; v < nVerts; v++) {
        const isLeft = basePos[v * 3] * leftSign > 0;
        const dst = isLeft ? lPos : rPos, dstN = isLeft ? lNrm : rNrm;
        for (let c = 0; c < 3; c++) {
          dst[v * 3 + c] = dPos[v * 3 + c];
          if (dNrm) dstN[v * 3 + c] = dNrm[v * 3 + c];
        }
      }
      const tL = { POSITION: appendVec3Accessor(lPos, true) };
      if (dNrm) tL.NORMAL = appendVec3Accessor(lNrm, false);
      const tR = { POSITION: appendVec3Accessor(rPos, true) };
      if (dNrm) tR.NORMAL = appendVec3Accessor(rNrm, false);
      prim.targets.push(tL, tR);
      if (prim.extras && prim.extras.targetNames) {
        prim.extras.targetNames.push('blink_l', 'blink_r');
      }
    }
    /* mesh-level targetNames is where three's GLTFLoader looks; Teddy only
       has them on the primitive, so promote those (now including the two
       new names) and fall back to synthetic names if neither exists. */
    if (!mesh.extras) mesh.extras = {};
    if (!mesh.extras.targetNames) {
      const primNames = mesh.primitives[0].extras && mesh.primitives[0].extras.targetNames;
      mesh.extras.targetNames = primNames ? primNames.slice() :
        Array.from({ length: baseCount }, (_, i) => 'morph_' + i).concat('blink_l', 'blink_r');
    } else {
      mesh.extras.targetNames.push('blink_l', 'blink_r');
    }
    newTargets.push([bind.mesh, baseCount, baseCount + 1]);
  }

  /* ---------- 2. blendShapeGroups: emotions sculpted from six morphs ---- */
  /* VRM0 bind weights are 0-100 (three-vrm multiplies by 0.01 on load).
     The palette: a=open jaw, i=wide/stretched mouth, u=pout/pucker,
     e=teeth-baring stretch, o=round jaw-drop, blink=both lids.
     Emotion weights stay subtle (20-60): on a muzzle, a soft shape read
     beats a screaming one, and avatar.js drives these up to ~1.0. */
  const mkGroup = (name, presetName, bindSpec) => ({
    name, presetName,
    binds: newTargets.flatMap(([meshIdx]) =>
      bindSpec.map(([preset, weight]) => ({
        mesh: meshIdx,
        index: morphIndexFor(preset, meshIdx),
        weight,
      }))),
    materialValues: [],
    isBinary: false,
  });

  groups.push(
    /* joy -> happy: 'i' pulls the mouth wide into a grin line, and a strong
       partial blink squints the eyes into smile-arcs — the classic
       closed-eye contented face, which reads clearly on a muzzle. */
    mkGroup('Joy', 'joy', [['i', 40], ['blink', 55]]),
    /* angry: 'e' bares/stretches the mouth (gritted teeth) and a quarter
       blink drops the lids into a glare rather than a sleepy droop. */
    mkGroup('Angry', 'angry', [['e', 50], ['blink', 25]]),
    /* sorrow -> sad: 'u' pushes the muzzle into a pout and a heavier
       one-third blink reads as downcast, heavy-lidded eyes. */
    mkGroup('Sorrow', 'sorrow', [['u', 45], ['blink', 35]]),
    /* fun -> relaxed: just gently lowered lids — a resting, content face.
       No mouth shape: relaxed is the idle baseline in avatar.js and any
       viseme bleed would fight the lipsync layer. */
    mkGroup('Fun', 'fun', [['blink', 25]]),
    /* surprised: custom expression (presetName 'unknown', name is what
       three-vrm registers). 'o' bound strongly = round jaw-drop gasp.
       Name must be lowercase 'surprised' — src/avatar.js checks
       exprAvail.has('surprised'). */
    mkGroup('surprised', 'unknown', [['o', 80]]),
  );
  /* blink_l / blink_r -> blinkLeft/blinkRight, full weight on the new
     side-masked morphs. avatar.js wink drives blinkLeft to 1. */
  groups.push(
    { name: 'Blink_L', presetName: 'blink_l', materialValues: [], isBinary: false,
      binds: newTargets.map(([m, L]) => ({ mesh: m, index: L, weight: 100 })) },
    { name: 'Blink_R', presetName: 'blink_r', materialValues: [], isBinary: false,
      binds: newTargets.map(([m, , R]) => ({ mesh: m, index: R, weight: 100 })) },
  );

  /* ---------- 3. reassemble the GLB ---------- */
  align4(); /* BIN chunk must be zero-padded to 4 bytes */
  const newBin = Buffer.concat(chunks, curLen);
  json.buffers[0].byteLength = newBin.length;

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]);

  const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + newBin.length);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  out.write('JSON', 16, 'ascii');
  jsonBuf.copy(out, 20);
  out.writeUInt32LE(newBin.length, 20 + jsonBuf.length);
  out.write('BIN\0', 24 + jsonBuf.length, 'ascii');
  newBin.copy(out, 28 + jsonBuf.length);
  return out;
}
