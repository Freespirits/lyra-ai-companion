/* Scene system: 360° skyboxes + lighting presets with soft crossfades.
   A scene is an equirect image (drop into public/scenes/) or a procedural
   gradient sky (the shipped defaults), plus a lighting preset that lerps.
   Switching is safe mid-speech; both the UI and the LLM's [scene:name]
   directive land here. */
import * as THREE from 'three';

const SKY_RADIUS = 30;
const FADE_SPEED = 1.1;      /* opacity units per second */
const LIGHT_SPEED = 2.2;     /* lighting lerp rate */

/* ---- живой sky: GLSL-animated aurora / nebula ----
   Noise is sampled in 3D view-direction space, so there is no wrap seam and
   the motion never loops visibly. Runs at full framerate for zero credits. */
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform float uTime, uOpacity, uKind;   /* kind: 0 = aurora, 1 = nebula */
uniform vec3 uTop, uMid, uBot, uGlow;

float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1,0,0)), u.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise3(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = uTime;

  /* vertical base gradient */
  vec3 col = mix(uBot, uMid, smoothstep(-1.0, 0.15, h));
  col = mix(col, uTop, smoothstep(0.05, 0.9, h));

  if (uKind < 0.5) {
    /* aurora: two drifting curtains + shimmer */
    float cur = fbm(d * 2.6 + vec3(0.0, t * 0.045, t * 0.028));
    float band = smoothstep(0.36, 0.6, cur) * smoothstep(-0.06, 0.18, h) * smoothstep(0.98, 0.3, h);
    vec3 aurCol = mix(vec3(0.29, 0.85, 0.78), uGlow, fbm(d * 1.7 - vec3(t * 0.03)));
    col += aurCol * band * 1.25;
    float cur2 = fbm(d * 4.1 + vec3(t * 0.03, -t * 0.05, 0.0));
    float band2 = smoothstep(0.44, 0.7, cur2) * smoothstep(0.05, 0.35, h) * smoothstep(1.0, 0.45, h);
    col += mix(uGlow, vec3(1.0, 0.42, 0.62), 0.35) * band2 * 0.6;
  } else {
    /* nebula: domain-warped billowing clouds in three tints */
    vec3 q = d * 2.2 + vec3(fbm(d * 3.0 + t * 0.012), fbm(d * 3.0 + 7.3 - t * 0.01), fbm(d * 3.0 + 15.7)) * 0.75;
    float cl = fbm(q * 1.8 + vec3(0.0, t * 0.014, 0.0));
    float cl2 = fbm(q * 3.3 - vec3(t * 0.01, 0.0, t * 0.008));
    col += uGlow * smoothstep(0.34, 0.85, cl) * 0.6;
    col += vec3(1.0, 0.35, 0.6) * smoothstep(0.52, 0.9, cl2) * 0.35;
    col += vec3(0.3, 0.8, 0.85) * smoothstep(0.6, 0.95, fbm(q * 2.6 + 31.0 + t * 0.01)) * 0.22;
  }

  /* horizon glow */
  col += uGlow * exp(-abs(h - 0.02) * 5.5) * 0.22;

  /* twinkling stars: round point inside its cell, not the whole square cell */
  vec3 cell = floor(d * 160.0);
  float s = hash3(cell);
  if (s > 0.992) {
    vec3 f = fract(d * 160.0) - 0.5;
    float dot_ = smoothstep(0.38, 0.08, length(f));
    float tw = 0.55 + 0.45 * sin(t * (2.0 + s * 6.0) + s * 100.0);
    col += vec3(1.0) * dot_ * tw * (0.35 + 0.65 * smoothstep(-0.1, 0.5, h)) * 1.6;
  }

  gl_FragColor = vec4(col, uOpacity);
}`;

const ANIMATED_KINDS = { aurora: 0, nebula: 1 };

function animatedSkyMaterial(def) {
  const p = def.procedural;
  return new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: Math.random() * 100 },
      uOpacity: { value: 0 },
      uKind: { value: ANIMATED_KINDS[p.kind] },
      uTop: { value: new THREE.Color(p.top) },
      uMid: { value: new THREE.Color(p.mid) },
      uBot: { value: new THREE.Color(p.bottom) },
      uGlow: { value: new THREE.Color(p.glow || '#a78bfa') },
    },
  });
}

function proceduralSky(def) {
  const w = 2048, h = 1024;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const p = def.procedural || { top: '#241b45', mid: '#141020', bottom: '#0b0817', stars: .5, glow: '#a78bfa' };

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, p.top);
  grad.addColorStop(.55, p.mid);
  grad.addColorStop(1, p.bottom);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);

  /* nebula clouds: layered radial blobs, additive */
  if (p.kind === 'nebula') {
    g.globalCompositeOperation = 'lighter';
    const tints = [p.glow || '#c17bff', '#ff6b9d', '#7de3d8', '#8b5cf6'];
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * w, y = Math.random() * h * .8;
      const r = h * (.12 + Math.random() * .3);
      const tint = tints[i % tints.length];
      const bl = g.createRadialGradient(x, y, 0, x, y, r);
      bl.addColorStop(0, tint + (i % 3 ? '22' : '38'));
      bl.addColorStop(.6, tint + '0e');
      bl.addColorStop(1, tint + '00');
      g.fillStyle = bl;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    /* milky-way band across the sky */
    g.save();
    g.translate(w * .5, h * .38); g.rotate(-.22);
    const band = g.createLinearGradient(0, -h * .12, 0, h * .12);
    band.addColorStop(0, '#ffffff00'); band.addColorStop(.5, '#e8e0ff2a'); band.addColorStop(1, '#ffffff00');
    g.fillStyle = band; g.fillRect(-w, -h * .12, 2 * w, h * .24);
    g.restore();
    g.globalCompositeOperation = 'source-over';
  }

  /* aurora ribbons: wavy vertical curtains, additive */
  if (p.kind === 'aurora') {
    g.globalCompositeOperation = 'lighter';
    const tints = ['#7de3d8', p.glow || '#a78bfa', '#ff6b9d'];
    for (let rIdx = 0; rIdx < 3; rIdx++) {
      const baseY = h * (.16 + rIdx * .1), amp = h * (.05 + Math.random() * .05);
      const phase = Math.random() * Math.PI * 2, tint = tints[rIdx];
      const fade = g.createLinearGradient(0, baseY - h * .14, 0, baseY + h * .22);
      fade.addColorStop(0, tint + '00'); fade.addColorStop(.45, tint + '3a'); fade.addColorStop(1, tint + '00');
      g.fillStyle = fade;
      g.beginPath();
      g.moveTo(0, baseY + amp * Math.sin(phase));
      /* integer wave count so the left and right edges meet (seamless wrap) */
      const waves = 2 + rIdx;
      for (let x = 0; x <= w; x += 16)
        g.lineTo(x, baseY + amp * Math.sin(phase + (x / w) * Math.PI * 2 * waves));
      for (let x = w; x >= 0; x -= 16)
        g.lineTo(x, baseY + h * .2 + amp * .7 * Math.sin(phase + 1 + (x / w) * Math.PI * 2 * waves));
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  /* horizon glow */
  if (p.glow) {
    const gl = g.createRadialGradient(w * .5, h * .56, 10, w * .5, h * .56, h * .55);
    gl.addColorStop(0, p.glow + '55');
    gl.addColorStop(.5, p.glow + '22');
    gl.addColorStop(1, p.glow + '00');
    g.fillStyle = gl; g.fillRect(0, 0, w, h);
    /* second, dimmer glow on the seam side so the wrap looks intentional */
    const gl2 = g.createRadialGradient(0, h * .5, 5, 0, h * .5, h * .4);
    gl2.addColorStop(0, p.glow + '26'); gl2.addColorStop(1, p.glow + '00');
    g.fillStyle = gl2; g.fillRect(0, 0, w, h);
    g.fillStyle = gl2; g.fillRect(w - h * .4, 0, h * .4, h);
  }

  /* stars: soft radial dots (hard pixels turn into ugly squares when the
     texture is magnified on the sky sphere) */
  const n = Math.round((p.stars || 0) * 900);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.pow(Math.random(), 1.6) * h * .6;
    const r = Math.random() * 2.2 + 1.2;
    const bright = .3 + Math.random() * .7;
    const tint = Math.random() < .12 ? (p.glow || '#ffffff') : '#ffffff';
    const st = g.createRadialGradient(x, y, 0, x, y, r * 2.4);
    st.addColorStop(0, tint + Math.round(bright * 255).toString(16).padStart(2, '0'));
    st.addColorStop(.4, tint + Math.round(bright * 90).toString(16).padStart(2, '0'));
    st.addColorStop(1, tint + '00');
    g.fillStyle = st;
    g.beginPath(); g.arc(x, y, r * 2.4, 0, Math.PI * 2); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* big equirect photos (Polyhaven ships 8K) eat VRAM: cap at 4096 wide */
function capTexture(tex, maxW = 4096) {
  const img = tex.image;
  if (!img || !img.width || img.width <= maxW) return tex;
  const c = document.createElement('canvas');
  c.width = maxW; c.height = Math.round(img.height * maxW / img.width);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  tex.dispose();
  const out = new THREE.CanvasTexture(c);
  out.colorSpace = THREE.SRGBColorSpace;
  return out;
}

export class SceneManager {
  constructor(avatar) {
    this.avatar = avatar;
    this.scenes = [];
    this.current = null;
    this.active = null;       /* {mesh, mat} fading in / resting */
    this.dying = [];          /* meshes fading out */
    this.lightTgt = null;
    this.onChange = () => {};
    this.soundOn = false;      /* scene ambience: unmute the scene video */
    this.duck = false;         /* true while she speaks: ambience drops low */
  }

  async init(startName) {
    try {
      const r = await fetch('/api/scenes');
      this.scenes = (await r.json()).scenes || [];
    } catch (e) { this.scenes = []; }
    if (this.scenes.length) await this.apply(startName || this.scenes[0].name, 0);
  }

  byName(name) {
    const n = String(name || '').toLowerCase().trim().replace(/\s+/g, '-');
    return this.scenes.find(s => s.name === n) ||
           this.scenes.find(s => s.name.includes(n) || n.includes(s.name));
  }

  async apply(name, fade = 1) {
    const def = this.byName(name);
    if (!def || (this.current && def.name === this.current.name)) return false;
    this.current = def;

    let tex = null, video = null;
    if (def.video) {
      /* animated background: a muted looping video drives the sky texture */
      try {
        video = document.createElement('video');
        video.src = def.video;
        video.muted = true; video.loop = true; video.playsInline = true;
        video.crossOrigin = 'anonymous';
        await new Promise((res, rej) => {
          video.oncanplay = res; video.onerror = () => rej(new Error('video load failed'));
          video.load();
        });
        video.play().catch(() => {});
        tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
      } catch (e) { video = null; tex = null; }
    }
    if (!tex && def.image) {
      try {
        tex = await new THREE.TextureLoader().loadAsync(def.image);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex = capTexture(tex);
      } catch (e) { tex = null; }
    }
    const group = new THREE.Group();
    const mats = [];
    const startOp = fade === 0 ? 1 : 0;
    const addMesh = (geom, mat, order) => {
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = order;
      group.add(mesh); mats.push(mat);
    };

    if (video && tex) {
      /* a flat video wrapped around a full sphere stretches into mush — show
         it on a curved cinema segment at its true aspect, over a dark backdrop */
      addMesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(def.lighting ? def.lighting.amb[0] : '#14101f').multiplyScalar(.16),
          side: THREE.BackSide, transparent: true, opacity: startOp, depthWrite: false,
        }), -1001);
      const aspect = (video.videoWidth || 21) / (video.videoHeight || 9);
      const phiLen = 2.5;                               /* ~143° horizontal arc */
      const thetaLen = Math.min(2.4, phiLen / aspect);  /* keep the frame's aspect */
      addMesh(new THREE.SphereGeometry(SKY_RADIUS * .96, 48, 32,
          Math.PI / 2 - phiLen / 2, phiLen, (Math.PI - thetaLen) / 2, thetaLen),
        new THREE.MeshBasicMaterial({
          map: tex, side: THREE.BackSide, transparent: true, opacity: startOp, depthWrite: false,
        }), -1000);
    } else if (tex) {
      addMesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32),
        new THREE.MeshBasicMaterial({
          map: tex, side: THREE.BackSide, transparent: true, opacity: startOp, depthWrite: false,
        }), -1000);
    } else if (def.procedural && def.procedural.kind in ANIMATED_KINDS) {
      /* live GLSL sky: aurora / nebula animated per-frame, seamless, loopless */
      const mat = animatedSkyMaterial(def);
      mat.opacity = startOp;
      mat.uniforms.uOpacity.value = startOp;
      addMesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), mat, -1000);
    } else {
      addMesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32),
        new THREE.MeshBasicMaterial({
          map: proceduralSky(def), side: THREE.BackSide, transparent: true, opacity: startOp, depthWrite: false,
        }), -1000);
    }

    if (this.current !== def) {                     /* superseded meanwhile */
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      if (video) { video.pause(); video.removeAttribute('src'); }
      return false;
    }
    /* seam/segment behind the avatar; per-scene yaw (degrees) picks the pretty side */
    group.rotation.y = Math.PI + (def.yaw || 0) * Math.PI / 180;
    this.avatar.scene.add(group);

    if (this.active) {
      if (this.active.video) this.active.video.muted = true;   /* old ambience out */
      this.dying.push(this.active);
    }
    this.active = { group, mats, video };
    if (video && this.soundOn) { video.muted = false; video.volume = 0; }

    if (def.lighting) {
      const L = def.lighting;
      this.lightTgt = {
        key: { color: new THREE.Color(L.key[0]), int: Math.PI * L.key[1] },
        rim: { color: new THREE.Color(L.rim[0]), int: Math.PI * L.rim[1] },
        amb: { color: new THREE.Color(L.amb[0]), int: Math.PI * L.amb[1] },
      };
    }
    this.onChange(def);
    return true;
  }

  /* called every frame from the main loop */
  update(dt) {
    if (this.active) {
      for (const m of this.active.mats) {
        if (m.opacity < 1) m.opacity = Math.min(1, m.opacity + dt * FADE_SPEED);
        this._syncShader(m, dt);
      }
      /* ambience volume: fade in, duck under her voice */
      const v = this.active.video;
      if (v && this.soundOn && !v.muted) {
        const tgt = this.duck ? .05 : .18;
        v.volume += (tgt - v.volume) * Math.min(1, dt * 3);
      }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      let gone = true;
      for (const m of d.mats) {
        m.opacity -= dt * FADE_SPEED;
        this._syncShader(m, dt);
        if (m.opacity > 0) gone = false;
      }
      if (gone) {
        this.avatar.scene.remove(d.group);
        d.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        for (const m of d.mats) { if (m.map) m.map.dispose(); m.dispose(); }
        if (d.video) { d.video.pause(); d.video.removeAttribute('src'); d.video.load(); }
        this.dying.splice(i, 1);
      }
    }
    if (this.lightTgt && this.avatar.lights) {
      const k = 1 - Math.exp(-dt * LIGHT_SPEED);
      for (const n of ['key', 'rim', 'amb']) {
        const light = this.avatar.lights[n], tgt = this.lightTgt[n];
        light.color.lerp(tgt.color, k);
        light.intensity += (tgt.int - light.intensity) * k;
      }
    }
  }

  setSound(on) {
    this.soundOn = on;
    const v = this.active && this.active.video;
    if (v) {
      v.muted = !on;
      if (on) { if (!v.volume) v.volume = 0; v.play().catch(() => {}); }
    }
  }

  /* animated skies: advance time, mirror .opacity into the shader */
  _syncShader(mat, dt) {
    if (!mat.uniforms) return;
    mat.uniforms.uTime.value += dt;
    mat.uniforms.uOpacity.value = Math.max(0, Math.min(1, mat.opacity));
  }
}
