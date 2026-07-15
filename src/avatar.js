/* Renderer + VRM avatar + procedural layer.
   The mocap layer (animations.js) owns the body when clips are present;
   this module always owns the face (visemes, expressions, blink, gaze),
   hair physics, word-beat accents, and a procedural idle fallback.

   Life systems:
   - mood vector: emotions are a continuous weighted blend that tags *nudge*
     and that decays slowly (the "emotional leak"), never a binary switch
   - saccadic gaze: instant micro-jumps + fixation jitter, not smooth tracking
   - asymmetric humanized blinking (one lid leads), exponential intervals
   - spring-bone tuning + head-inertia coupling so hair/clothes carry weight
   - subconscious micro-events (breaths, glances, weight shifts)             */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { PostFX, initialTier, applyCelMaterials } from './render-fx.js';

export const EMO = {
  neutral:   { expr: { relaxed: .15 },              lid: .05, gaze: { x: 0,  y: 0 } },
  happy:     { expr: { happy: .95 },                lid: 0,   gaze: { x: 0,  y: 0 },    fx: 'sparkle' },
  excited:   { expr: { happy: 1, surprised: .2 },   lid: 0,   gaze: { x: 0,  y: 0 },    fx: 'sparkle' },
  surprised: { expr: { surprised: 1 },              lid: 0,   gaze: { x: 0,  y: 0 },    fx: 'sparkle' },
  sad:       { expr: { sad: .9 },                   lid: .22, gaze: { x: 0,  y: -.12 } },
  thinking:  { expr: { relaxed: .3 },               lid: .12, gaze: { x: .3, y: .22 } },
};
const EMO_EXPR = ['happy', 'sad', 'angry', 'relaxed', 'surprised'];
const VIS_EXPR = ['aa', 'ih', 'ou', 'ee', 'oh'];

/* Dynamic affect: a sustained stance held in face + eyes + posture until
   changed (the LLM declares it with [affect:...]). Unlike mood bursts these
   don't decay — they ARE how she's carrying herself right now.
     teasing  = smirk (smug happy/angry blend), heavy lids, head tilt
     focused  = serious brow, steady gaze (saccades damped), lean-in
     warm     = soft, warm eyes, gentle tilt (loyal-friend attentiveness)
     fierce   = hard brow, locked gaze, squared posture                     */
export const AFFECTS = {
  neutral: { expr: {},                                          lid: 0,   tiltZ: 0,    lean: 0,    gazeY: 0,    sacc: 1 },
  teasing: { expr: { happy: .38, relaxed: .28, angry: .12 },    lid: .2,  tiltZ: .09,  lean: 0,    gazeY: -.04, sacc: 1 },
  focused: { expr: { angry: .1, relaxed: .12 },                 lid: .05, tiltZ: 0,    lean: .05,  gazeY: 0,    sacc: .45 },
  warm:    { expr: { relaxed: .45, happy: .22 },                lid: .2,  tiltZ: .05,  lean: .02,  gazeY: -.05, sacc: .7 },
  fierce:  { expr: { angry: .35, surprised: .08 },              lid: .1,  tiltZ: -.05, lean: .04,  gazeY: 0,    sacc: .5 },
};

/* hair/clothes weight: <1 stiffness+drag = more swing and settle,
   headInertia = how much sharp head/body motion drags the strands */
const SPRING_TUNE = { stiffness: .85, drag: .78, gravity: 1.1, headInertia: .55, wind: 1 };
const MOOD_DECAY_TAU = 9;      /* seconds for a mood nudge to fade ~63% */

const lerp = (a, b, k) => a + (b - a) * k;
const osc = (t, f1, f2, ph) => (Math.sin(t * f1 + ph) + .6 * Math.sin(t * f2 + ph * 1.7)) / 1.6;

export class Avatar {
  constructor(canvas, host) {
    this.canvas = canvas; this.host = host;
    this.vrm = null; this.bones = {}; this.hipsBase = null;
    this.armBase = { l: -1.12, r: 1.12 }; this.dropSign = { l: -1, r: 1 }; this.F = 1;
    this.headY = 1.35;
    this.exprAvail = null; this.springJoints = null;
    this.mood = { neutral: .4 };            /* continuous weighted emotion blend */
    this.affect = 'neutral'; this.affectW = 0;   /* sustained stance + its blend-in weight */
    this.exprCur = {};
    this.blink = 0; this.blinkT = -1; this.nextBlink = performance.now() + 1800;
    this.blinkAsym = 0;                     /* per-blink lid lead (seconds, signed) */
    this.winkT = 0; this.lid = 0;
    this.gazeCur = { x: 0, y: 0 };
    this.sacc = { next: 0, home: true, tx: 0, ty: 0 };
    this.userGaze = { x: 0, y: 0, t: 0 };   /* where YOU are in her view (face tracking) */
    this.wordBob = 0; this.jaw = 0;         /* audio-energy jaw fallback */
    /* subconscious life layer: micro-events independent of the state machine */
    this.micro = {
      expr: [], breathBoost: 0, shoulderT: 0, nodT: 0, leanT: 0, leanDur: 1.6,
      weightCur: 0, weightTgt: 0, nextLife: performance.now() + 5000, pendingDouble: false,
    };
    this.speaking = false;
    this.mocapActive = false;                  /* set by main when clips loaded */
    this.viseme = () => 'REST';                /* injected by speech module */
    this.onFx = () => {};
    this._headPrev = new THREE.Vector3();
    this._headVel = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
    this._initScene();
  }

  /* dominant mood, for aura / idle flavor / status */
  get emotion() {
    let best = 'neutral', bw = .12;
    for (const k in this.mood) if (this.mood[k] > bw) { bw = this.mood[k]; best = k; }
    return best;
  }

  _initScene() {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    /* soft image-based fill so forms gain gentle volume under the cel shading;
       kept low so the toon look dominates (MToon ignores it; standard parts —
       eyes, accessories — benefit) */
    if (initialTier() !== 'off') try {
      const pmrem = new THREE.PMREMGenerator(r);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
      this.scene.environmentIntensity = .35;
      pmrem.dispose();
    } catch (e) {}
    this.camera = new THREE.PerspectiveCamera(28, 1, .05, 80);
    this.camera.position.set(0, 1.1, 2.4);
    this.scene.add(this.camera);
    this.lookAtTarget = new THREE.Object3D();
    this.camera.add(this.lookAtTarget);

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * .38); key.position.set(1.2, 1.8, 2.2);
    const rim = new THREE.DirectionalLight(0x7de3d8, Math.PI * .14); rim.position.set(-1.5, 1.2, -1.5);
    const amb = new THREE.AmbientLight(0xbfb8ff, Math.PI * .22);
    this.lights = { key, rim, amb };          /* scene manager lerps these */
    this.scene.add(key, rim, amb);

    /* cel-shaded HD post stack (owns tone mapping; 'off' = plain render) */
    this.postfx = new PostFX(r, this.scene, this.camera, initialTier());

    /* soft contact shadow */
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(128, 128, 10, 128, 128, 120);
    gr.addColorStop(0, 'rgba(0,0,0,.40)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(.6, 40),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2; blob.position.y = .005;
    this.scene.add(blob);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .08;
    this.controls.minDistance = .5; this.controls.maxDistance = 5;
    this.controls.maxPolarAngle = Math.PI * .58;
    this.controls.target.set(0, 1, 0);

    this.clock = new THREE.Clock();
    const size = () => {
      const w = this.host.clientWidth || 640, h = this.host.clientHeight || 640;
      r.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      if (this.postfx) this.postfx.setSize(w, h, window.devicePixelRatio || 1);
    };
    size(); window.addEventListener('resize', size);
  }

  async load(url) {
    const vrm = await this._loadVRM(url);
    this._attach(vrm);
    this.frame('full');
    return vrm;
  }

  /* live body swap: load the new model fully before touching the current one,
     so the old body keeps performing until the new one is ready */
  async swapModel(url) {
    const vrm = await this._loadVRM(url);
    const old = this.vrm;
    if (old) {
      this.scene.remove(old.scene);
      try { VRMUtils.deepDispose(old.scene); } catch (e) {}
    }
    this._attach(vrm);
    return vrm;
  }

  async _loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (VRMUtils.removeUnnecessaryVertices) VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (VRMUtils.combineSkeletons) VRMUtils.combineSkeletons(gltf.scene);
    return vrm;
  }

  _attach(vrm) {
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse(o => { o.frustumCulled = false; });
    /* cel material tuning only when the FX stack is on; 'off' = untouched
       original VRM look (the known-good baseline) */
    if (this.postfx && this.postfx.tier !== 'off') {
      try { applyCelMaterials(vrm, this.renderer); } catch (e) { console.warn('[lyra] cel materials skipped:', e); }
    }

    const hb = n => { try { return vrm.humanoid.getNormalizedBoneNode(n); } catch (e) { return null; } };
    this.bones = {
      hips: hb('hips'), spine: hb('spine'), chest: hb('chest'), upperChest: hb('upperChest'),
      neck: hb('neck'), head: hb('head'),
      lArm: hb('leftUpperArm'), lLo: hb('leftLowerArm'),
      rArm: hb('rightUpperArm'), rLo: hb('rightLowerArm'),
    };
    vrm.scene.updateWorldMatrix(true, true);
    this.armBase.l = this._solveArmDrop(this.bones.lArm, this.bones.lLo, 1.12);
    this.armBase.r = this._solveArmDrop(this.bones.rArm, this.bones.rLo, 1.12);
    this.dropSign.l = Math.sign(this.armBase.l) || -1;
    this.dropSign.r = Math.sign(this.armBase.r) || 1;
    this.F = this.armBase.l < 0 ? 1 : -1;
    for (const side of ['left', 'right']) {
      const s = side === 'left' ? this.dropSign.l : this.dropSign.r;
      for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
        const p1 = hb(side + f + 'Proximal'), p2 = hb(side + f + 'Intermediate');
        if (p1) p1.rotation.z = s * .30;
        if (p2) p2.rotation.z = s * .24;
      }
    }
    if (this.bones.hips) this.hipsBase = this.bones.hips.position.clone();
    if (vrm.lookAt) vrm.lookAt.target = this.lookAtTarget;

    this.exprAvail = new Set();
    try {
      (vrm.expressionManager && vrm.expressionManager.expressions || []).forEach(x =>
        this.exprAvail.add(x.expressionName || x.name));
    } catch (e) { this.exprAvail = null; }
    this.exprCur = {};

    try {
      const sbm = vrm.springBoneManager;
      if (sbm && sbm.joints) {
        this.springJoints = [];
        sbm.joints.forEach(j => {
          if (!j.settings) return;
          /* weight + inertia tuning */
          if (typeof j.settings.stiffness === 'number') j.settings.stiffness *= SPRING_TUNE.stiffness;
          if (typeof j.settings.dragForce === 'number') j.settings.dragForce *= SPRING_TUNE.drag;
          if (j.settings.gravityDir)
            this.springJoints.push({ j, base: j.settings.gravityDir.clone(), power: (j.settings.gravityPower || 0) * SPRING_TUNE.gravity });
        });
        if (!this.springJoints.length) this.springJoints = null;
      }
    } catch (e) { this.springJoints = null; }

    vrm.scene.updateWorldMatrix(true, true);
    const p = new THREE.Vector3();
    (this.bones.head || vrm.scene).getWorldPosition(p);
    this.headY = p.y || 1.35;
    this._headPrev.copy(p);
    this._headVel.set(0, 0, 0);
  }

  _solveArmDrop(upper, lower, angle) {
    if (!upper || !lower) return -angle;
    const p = new THREE.Vector3();
    let best = -angle, bestY = Infinity;
    for (const s of [-1, 1]) {
      upper.rotation.z = s * angle;
      upper.updateWorldMatrix(true, true);
      lower.getWorldPosition(p);
      if (p.y < bestY) { bestY = p.y; best = s * angle; }
    }
    upper.rotation.z = best;
    upper.updateWorldMatrix(true, true);
    return best;
  }

  frame(mode) {
    if (mode === 'close') {
      this.camera.position.set(0, this.headY + .04, .9);
      this.controls.target.set(0, this.headY - .05, 0);
    } else {
      /* wide enough to keep hair in frame on a fullscreen viewport */
      this.camera.position.set(0, this.headY * .72, this.headY * 2.35);
      this.controls.target.set(0, this.headY * .58, 0);
    }
  }

  /* ---- mood API ---- */
  /* additive nudge: the new feeling layers over what's already simmering */
  nudgeMood(name, w = .7) {
    if (!EMO[name] || name === 'neutral') return;
    this.mood[name] = Math.min(1, (this.mood[name] || 0) + w);
    if (EMO[name].fx && w >= .6) this.onFx(EMO[name].fx);
  }
  /* hard set (state machine / test buttons): clears the blend */
  setEmotion(n) {
    if (!EMO[n]) n = 'neutral';
    this.mood = { neutral: .25 };
    if (n !== 'neutral') this.mood[n] = .95;
    if (EMO[n].fx) this.onFx(EMO[n].fx);
  }
  /* sustained stance; entering one fires a small physical flourish */
  setAffect(name) {
    if (!AFFECTS[name] || name === this.affect) return;
    this.affect = name;
    if (name === 'teasing') this.proceduralGesture('tilt');
    else if (name === 'focused') this.microLean(1.5);
    else if (name === 'warm') { this.micro.breathBoost = 1; this.microExpression('happy', .3, 1.4); }
    else if (name === 'fierce') this.microExpression('surprised', .25, .5);
  }
  /* face tracking: her eyes follow you around the frame */
  setUserGaze(nx, ny) {
    this.userGaze.x = nx; this.userGaze.y = ny; this.userGaze.t = performance.now();
  }
  wink() { this.winkT = .5; }
  bobPulse() { this.wordBob = 1; }

  /* nod / tilt fallbacks for when a gesture has no mocap clip */
  proceduralGesture(name) { this._pg = { name, t: 0, dur: name === 'nod' ? .9 : 1.1, dir: Math.random() < .5 ? -1 : 1 }; }

  /* micro-behavior API: tiny, layered, never touches the state machine */
  microExpression(name, amt, dur) {
    this.micro.expr.push({ name, amt, durMs: dur * 1000, until: performance.now() + dur * 1000 });
  }
  microNod(scale = 1) { this.micro.nodT = .5 * scale; }
  microLean(dur = 1.6) { this.micro.leanT = dur; this.micro.leanDur = dur; }

  /* weighted blend of EMO presets from the mood vector */
  _moodBlend() {
    const expr = {}; let lid = 0, gx = 0, gy = 0, wSum = 0;
    for (const k in this.mood) {
      const w = this.mood[k], e = EMO[k];
      if (!e || w < .02) continue;
      for (const n in e.expr) expr[n] = Math.min(1, (expr[n] || 0) + e.expr[n] * Math.min(1, w));
      lid += e.lid * w; gx += e.gaze.x * w; gy += e.gaze.y * w; wSum += w;
    }
    if (wSum > 0) { lid /= Math.max(1, wSum); gx /= Math.max(1, wSum); gy /= Math.max(1, wSum); }
    return { expr, lid, gaze: { x: gx, y: gy } };
  }

  update(dt, preUpdate) {
    const now = performance.now(), ts = now / 1000;
    const F = this.F;

    /* mood decays back toward neutral: feelings linger, then fade */
    const decay = Math.exp(-dt / MOOD_DECAY_TAU);
    for (const k in this.mood) {
      if (k === 'neutral') continue;
      this.mood[k] *= decay;
      if (this.mood[k] < .02) delete this.mood[k];
    }
    const blend = this._moodBlend();
    /* affect ramps in/out smoothly; its definition shapes everything below */
    this.affectW = lerp(this.affectW, this.affect === 'neutral' ? 0 : 1, 1 - Math.exp(-dt * 3));
    const AD = AFFECTS[this.affect] || AFFECTS.neutral, aw = this.affectW;

    if (this.blinkT < 0 && now > this.nextBlink) {
      this.blinkT = 0;
      this.blinkAsym = (Math.random() < .5 ? -1 : 1) * (.012 + Math.random() * .03);
      /* human blink timing: exponential intervals, occasional double blink */
      if (this.micro.pendingDouble) {
        this.nextBlink = now + 230;
        this.micro.pendingDouble = false;
      } else {
        this.nextBlink = now + Math.min(7500, 900 + -Math.log(Math.random()) * 2600);
        this.micro.pendingDouble = Math.random() < .15;
      }
    }
    let blinkL = 0, blinkR = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const env = t => { const p = t / .16; return p > 0 && p < 1 ? Math.sin(p * Math.PI) : 0; };
      /* one lid leads the other by a few frames */
      blinkL = env(this.blinkT + Math.max(0, this.blinkAsym));
      blinkR = env(this.blinkT + Math.max(0, -this.blinkAsym));
      this.blink = Math.max(blinkL, blinkR);
      if (this.blinkT > .16 + Math.abs(this.blinkAsym)) { this.blinkT = -1; this.blink = 0; blinkL = blinkR = 0; }
    }
    if (this.winkT > 0) this.winkT -= dt;
    /* sustained droop is capped: relaxed half-lidded eyes yes, asleep no */
    this.lid = lerp(this.lid, Math.min(.26, blend.lid + AD.lid * aw), 1 - Math.exp(-dt * 6));

    /* saccadic gaze: instant micro-jumps, fixation jitter between them.
       a focused/fierce stance damps the wander: the gaze locks on */
    if (now > this.sacc.next) {
      const sscale = 1 + (AD.sacc - 1) * aw;
      const r = Math.random();
      if (this.sacc.home && r < .14 * sscale) {
        /* glance away */
        this.sacc.tx = (Math.random() - .5) * .7 * sscale;
        this.sacc.ty = (Math.random() < .5 ? .2 : -.16) * sscale;
        this.sacc.home = false;
        this.sacc.next = now + 350 + Math.random() * 900;
      } else {
        /* refixate on the user with a small offset (eyes scan a face) */
        this.sacc.tx = (Math.random() - .5) * .13 * sscale;
        this.sacc.ty = (Math.random() - .5) * .08 * sscale;
        this.sacc.home = true;
        this.sacc.next = now + 700 + Math.random() * 2300;
      }
      /* home fixation tracks YOUR position when the camera sees you */
      const gu = this.userGaze;
      const trackUser = this.sacc.home && now - gu.t < 3000;
      const hx = trackUser ? gu.x * .4 : 0, hy = trackUser ? gu.y * .25 : 0;
      /* the jump itself is instantaneous: that's what reads as alive */
      this.gazeCur.x = blend.gaze.x + hx + this.sacc.tx;
      this.gazeCur.y = blend.gaze.y + hy + AD.gazeY * aw + this.sacc.ty;
    }
    /* micro-drift during fixation (eyes only; kept tiny so nothing shivers) */
    this.gazeCur.x += (Math.random() - .5) * .0015;
    this.gazeCur.y += (Math.random() - .5) * .001;
    this.lookAtTarget.position.set(this.gazeCur.x * .6, this.gazeCur.y * .4, 0);

    this.wordBob *= Math.exp(-dt * 7);

    /* subconscious life layer: randomized micro-events, always running,
       independent of the conversation state machine */
    const M = this.micro;
    if (now > M.nextLife) {
      M.nextLife = now + 4000 + Math.random() * 11000;
      const r = Math.random();
      if (r < .2) this.microExpression(Math.random() < .6 ? 'relaxed' : 'happy', .22 + Math.random() * .15, .9);
      else if (r < .32) this.microExpression('surprised', .16, .5);       /* brow flash */
      else if (r < .48) {                                                 /* deliberate glance aside */
        this.sacc.next = now + 1200;
        this.sacc.home = false;
        this.gazeCur.x = (Math.random() - .5) * .6;
        this.gazeCur.y = Math.random() < .5 ? .18 : -.14;
      }
      else if (r < .62) M.breathBoost = 1;                                /* one deeper breath */
      else if (r < .78) M.shoulderT = 1.4;                                /* shoulder shift */
      else if (r < .92) M.weightTgt = (Math.random() - .5) * .02;         /* weight adjust */
      else this.microNod(.5);
    }
    M.breathBoost *= Math.exp(-dt * 1.1);
    if (M.shoulderT > 0) M.shoulderT -= dt;
    if (M.nodT > 0) M.nodT -= dt;
    if (M.leanT > 0) M.leanT -= dt;
    M.weightCur += (M.weightTgt - M.weightCur) * (1 - Math.exp(-dt * 1.4));

    /* mocap layer writes the skeleton here */
    if (preUpdate) preUpdate(dt);

    if (this.vrm) {
      const B = this.bones;
      if (!this.mocapActive) {
        /* procedural idle fallback (no clips present) */
        const ws = osc(ts, .33, .21, 0), ys = osc(ts, .19, .27, 2), br = Math.sin(ts * 1.5);
        if (B.hips && this.hipsBase) {
          B.hips.position.set(this.hipsBase.x + .015 * ws, this.hipsBase.y, this.hipsBase.z);
          B.hips.rotation.set(0, .045 * ys, F * .028 * ws);
        }
        if (B.spine) B.spine.rotation.set(0, 0, F * -.018 * ws);
        if (B.neck) B.neck.rotation.set(0, 0, 0);   /* accents below are additive: reset or they accumulate */
        if (B.chest) B.chest.rotation.set(F * .012 * br, -.02 * ys, F * -.008 * ws);
        if (B.upperChest) B.upperChest.rotation.set(F * .008 * Math.sin(ts * 1.5 + .6), 0, 0);
        if (B.head) B.head.rotation.set(F * .012 * osc(ts, .5, .9, 5), .02 * osc(ts, .23, .4, 3), F * .01 * ws);
        if (B.lArm) B.lArm.rotation.set(F * .03 * osc(ts, .31, .47, 2), 0, this.armBase.l + this.dropSign.l * (-.05 + .025 * osc(ts, .37, .53, 1)));
        if (B.rArm) B.rArm.rotation.set(F * .03 * osc(ts, .29, .43, 5), 0, this.armBase.r + this.dropSign.r * (-.05 + .025 * osc(ts, .41, .59, 4)));
      }

      /* additive accents on top of whatever the body layer did.
         word-bob is a whisper, not a twitch: with word-exact timestamps and
         long replies it fires constantly, and the talk clips already move
         the head — keep it barely perceptible */
      const bobAmp = this.mocapActive ? .012 : .02;
      if (B.head) {
        B.head.rotation.x += F * bobAmp * this.wordBob;
        B.head.rotation.z += F * .02 * Math.sin(ts * .4);
        if (M.nodT > 0) B.head.rotation.x += F * .06 * Math.sin(M.nodT * 12) * Math.min(1, M.nodT * 4);
      }
      if (B.neck) B.neck.rotation.x += F * .006 * this.wordBob;
      if (B.chest) {
        B.chest.rotation.x += F * .02 * M.breathBoost * Math.sin(ts * 3.1);
        if (M.shoulderT > 0) B.chest.rotation.z += F * .015 * Math.sin(Math.PI * Math.min(1, M.shoulderT / 1.4));
      }
      if (B.spine && M.leanT > 0) B.spine.rotation.x += F * .055 * Math.sin(Math.PI * Math.min(1, M.leanT / M.leanDur));
      /* affect posture: sustained tilt / lean-in held as long as the stance holds */
      if (aw > .01) {
        if (B.head) B.head.rotation.z += F * AD.tiltZ * aw;
        if (B.spine) B.spine.rotation.x += F * AD.lean * aw;
      }
      if (B.hips && this.hipsBase) B.hips.position.x += M.weightCur;
      if (this._pg) {
        const pg = this._pg; pg.t += dt;
        if (pg.t >= pg.dur) this._pg = null;
        else if (B.head) {
          if (pg.name === 'nod') B.head.rotation.x += F * .13 * Math.sin(pg.t * 13) * Math.min(1, (pg.dur - pg.t) * 3);
          else B.head.rotation.z += F * .2 * pg.dir * Math.sin(Math.PI * pg.t / pg.dur);
        }
      }

      /* hair/clothes physics: wind + head-inertia drag through spring gravity */
      if (this.springJoints) {
        /* head velocity in world space: sharp motion drags the strands behind */
        (B.head || this.vrm.scene).getWorldPosition(this._tmpV);
        if (dt > 0) {
          this._headVel.lerp(
            this._tmpV.clone().sub(this._headPrev).divideScalar(Math.max(dt, 1e-4)),
            1 - Math.exp(-dt * 10));
        }
        this._headPrev.copy(this._tmpV);
        const k = SPRING_TUNE.headInertia;
        const ix = THREE.MathUtils.clamp(-this._headVel.x * k, -.6, .6);
        const iz = THREE.MathUtils.clamp(-this._headVel.z * k, -.6, .6);
        const wx = SPRING_TUNE.wind * .22 * (Math.sin(ts * 1.3) + .5 * Math.sin(ts * 2.7 + 1));
        const wz = SPRING_TUNE.wind * .14 * Math.sin(ts * .9 + 2);
        for (const s of this.springJoints) {
          const d = s.j.settings.gravityDir;
          d.copy(s.base); d.x += wx + ix; d.z += wz + iz;
          if (d.lengthSq() > 1e-6) d.normalize();
          s.j.settings.gravityPower = s.power + .04 * Math.abs(wx) + .1 * (Math.abs(ix) + Math.abs(iz));
        }
      }

      /* face: visemes fast lane, mood blend slow lane */
      const t = { blink: this.lid, blinkLeft: 0, blinkRight: 0 };
      for (const n of EMO_EXPR) t[n] = 0;
      for (const n of VIS_EXPR) t[n] = 0;
      for (const k in blend.expr) t[k] = blend.expr[k];
      /* affect face layer: max-blend over the mood (blush etc. skip gracefully
         when the model lacks the blendshape — the write loop checks exprAvail) */
      if (aw > .01) for (const k in AD.expr) t[k] = Math.max(t[k] || 0, AD.expr[k] * aw);
      const hasLR = this.exprAvail && this.exprAvail.has('blinkLeft') && this.exprAvail.has('blinkRight');
      if (hasLR) { t.blinkLeft = blinkL; t.blinkRight = blinkR; }
      else t.blink = Math.max(t.blink, this.blink);
      if (this.speaking) {
        const m = this.viseme();
        if (m) t[m.n] = Math.max(t[m.n], m.v);
        t.aa = Math.max(t.aa, this.jaw * .7);   /* audio-energy fallback */
      }
      if (this.winkT > 0) t.blinkLeft = 1;
      /* fleeting micro-expressions: appear and vanish with a sine envelope */
      if (M.expr.length) {
        M.expr = M.expr.filter(m => now < m.until);
        for (const m of M.expr) {
          const p = 1 - (m.until - now) / m.durMs;
          const w = m.amt * Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
          if (t[m.name] !== undefined) t[m.name] = Math.max(t[m.name], w);
        }
      }
      const kFast = 1 - Math.exp(-dt * 24), kSlow = 1 - Math.exp(-dt * 9);
      for (const name in t) {
        if (this.exprAvail && !this.exprAvail.has(name)) continue;
        const fast = VIS_EXPR.indexOf(name) > -1 || name.indexOf('blink') === 0;
        const next = lerp(this.exprCur[name] || 0, t[name], fast ? kFast : kSlow);
        this.exprCur[name] = next;
        try { this.vrm.expressionManager && this.vrm.expressionManager.setValue(name, next); } catch (err) {}
      }
      this.vrm.update(dt);
    }
    this.controls.update();
    if (this.postfx) {
      if (this.vrm) {                                  /* keep the face at DOF focus */
        (this.bones.head || this.vrm.scene).getWorldPosition(this._tmpV);
        this.postfx.setFocusDistance(this.camera.position.distanceTo(this._tmpV));
      }
      this.postfx.sampleFps(dt);
      this.postfx.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
