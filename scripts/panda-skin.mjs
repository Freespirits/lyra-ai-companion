/* Repaints the Teddy albedo into a giant panda, in place inside bao.vrm.

   There is no panda VRM under an open license anywhere, so Bao's body is
   "Teddy" by Polygonal Mind (CC0) — a round, upright, humanoid-rigged bear
   that arrives brown. CC0 explicitly permits modification, and the model is
   one mesh / one material / one 1024x1024 albedo, so the whole conversion is
   a repaint of that single texture.

   This runs from fetch-assets.mjs after the download, not by hand: bao.vrm is
   gitignored, so a fresh clone re-fetches Teddy and would get a brown bear
   again unless the recolor is part of the pipeline.

   No image dependency — PNG here is 8-bit RGBA, non-interlaced, and node's
   zlib does the only hard part. */
import zlib from 'zlib';

/* ---------- minimal PNG (8-bit RGBA, non-interlaced) ---------- */
function decodePng(buf) {
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12);
      if (buf[o + 16] !== 8 || buf[o + 17] !== 6 || buf[o + 20] !== 0) {
        throw new Error('expected 8-bit RGBA non-interlaced PNG');
      }
    } else if (type === 'IDAT') idat.push(buf.slice(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  const stride = w * 4;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = px.slice(y * stride, (y + 1) * stride);
    const prev = y ? px.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {                        /* Paeth */
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, px };
}

function encodePng({ w, h, px }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {                       /* filter 0: honest and small enough */
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return c ^ -1;
}

/* ---------- the repaint ---------- */
/* Atlas layout, read off the texture: front body+head top-left, back body on
   the right, limbs along the bottom, small pieces scattered. Coordinates are
   in 1024-space. */
const BLACK_RECTS = [
  [30, 690, 500, 1024],     /* bottom-left limb islands   */
  [500, 740, 700, 1024],    /* bottom-middle strips        */
  [700, 730, 1024, 1024],   /* feet / paw circles          */
  [20, 0, 90, 140],         /* small top-left ear pieces   */
  /* No shoulder band: a real panda has one, but where it lands on this mesh
     cannot be verified without rendering, and a black band a few pixels off
     reads as a belt. The black arms and legs already carry the marking. */
];
const BLACK_ELLIPSES = [
  [206, 116, 38, 36],       /* left eye patch   */
  [274, 116, 38, 36],       /* right eye patch  */
  [110, 40, 70, 52],        /* left ear on head */
  [372, 40, 70, 52],        /* right ear        */
];

export function pandaify(pngBuf) {
  const img = decodePng(pngBuf);
  const { w, h, px } = img;

  /* 1. brown fur -> white fur, keeping the painted shading. Luminance is
        remapped rather than replaced, so the fur detail survives. */
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;                    /* atlas gutter */
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (lum < 26) continue;                           /* keep the existing black bits (eyes, brows) */
    const v = Math.max(0, Math.min(255, Math.round(150 + (lum / 255) * 118)));
    px[i] = v; px[i + 1] = v; px[i + 2] = v;
  }

  /* 2. panda markings. Keep a little of the shading under the black so the
        limbs do not read as flat cutouts. */
  const paint = (x, y) => {
    const i = (y * w + x) * 4;
    if (px[i + 3] === 0) return;
    const shade = px[i] / 255;
    const v = Math.round(8 + shade * 26);
    px[i] = v; px[i + 1] = v; px[i + 2] = v;
  };
  for (const [x0, y0, x1, y1] of BLACK_RECTS) {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) paint(x, y);
    }
  }
  for (const [cx, cy, rx, ry] of BLACK_ELLIPSES) {
    for (let y = Math.max(0, cy - ry); y < Math.min(h, cy + ry); y++) {
      for (let x = Math.max(0, cx - rx); x < Math.min(w, cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) paint(x, y);
      }
    }
  }
  return encodePng(img);
}

/* ---------- swap the texture back into the .vrm (GLB) ---------- */
export function repaintVrm(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  const binHeader = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binHeader);
  const binStart = binHeader + 8;
  const bin = glb.slice(binStart, binStart + binLen);

  const imgIdx = (json.images || []).findIndex(i => i.bufferView !== undefined);
  if (imgIdx < 0) throw new Error('no embedded image to repaint');
  const bv = json.bufferViews[json.images[imgIdx].bufferView];
  const old = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const next = pandaify(old);

  /* Rebuild BIN with the new texture in place; every bufferView after the
     texture shifts, so fix their offsets by the delta. */
  const delta = next.length - old.length;
  const head = bin.slice(0, bv.byteOffset || 0);
  const tail = bin.slice((bv.byteOffset || 0) + bv.byteLength);
  let newBin = Buffer.concat([head, next, tail]);
  const pad = (4 - (newBin.length % 4)) % 4;
  if (pad) newBin = Buffer.concat([newBin, Buffer.alloc(pad)]);

  for (const v of json.bufferViews) {
    if ((v.byteOffset || 0) > (bv.byteOffset || 0)) v.byteOffset = (v.byteOffset || 0) + delta;
  }
  bv.byteLength = next.length;
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
