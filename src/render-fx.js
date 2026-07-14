/* Cel-shaded HD post-processing.
   One EffectComposer wrapping the single unified scene (avatar + 360 skybox),
   so DOF focuses on the near character and blurs the far sky — the portrait
   background-bokeh look — while the subject stays razor sharp (supersampling +
   MSAA + a light sharpen). Everything is tier-gated so a strong PC gets the
   full stack and weak/mobile hardware still runs.

   Pipeline (full): Render(MSAA, SSAA'd) -> SSAO -> Bloom -> DOF
                    -> OutputPass(ACES tonemap + sRGB) -> grade(vignette,
                    grain, sharpen, chromatic aberration).
   HDR-linear effects (bloom/DOF) sit before tone mapping; display-space
   effects (grade) sit after. 'off' bypasses the composer entirely — a
   guaranteed zero-overhead baseline identical to a plain renderer.render(). */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { MToonMaterial } from '@pixiv/three-vrm';

export const TIERS = ['off', 'low', 'medium', 'high', 'full'];

/* cel look at the material level, applied once per loaded VRM.
   Conservative: crisps the toon step, adds a soft coloured rim (the portrait
   edge-glow), and maxes texture sharpness. Outlines are only *enabled* where the
   model already ships them (respecting the author) or given a thin default so we
   never draw ink lines the model wasn't built for in a way that looks wrong.
   `rim` is a THREE.Color the scene manager can retint later. */
export const CEL = { toony: .95, shift: -.08, rimMix: .55, rimColor: 0x9fb6ff, rimLift: .10, outline: .0009 };

export function applyCelMaterials(vrm, renderer) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 8;
  const aniso = Math.min(16, maxAniso || 8);
  const rim = new THREE.Color(CEL.rimColor);
  vrm.scene.traverse(o => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      /* sharpen every texture map this material carries */
      for (const key of ['map', 'emissiveMap', 'shadeMultiplyTexture', 'normalMap', 'rimMultiplyTexture']) {
        const t = m[key];
        if (t && t.isTexture) { t.anisotropy = aniso; t.generateMipmaps = true; t.needsUpdate = true; }
      }
      if (m instanceof MToonMaterial) {
        m.shadingToonyFactor = CEL.toony;
        m.shadingShiftFactor = CEL.shift;
        m.parametricRimColorFactor = rim.clone();
        m.rimLightingMixFactor = CEL.rimMix;
        m.parametricRimLiftFactor = CEL.rimLift;
        /* only give a thin outline where the author left none, so faces the
           model already inks stay as designed */
        if (!m.outlineWidthMode || m.outlineWidthMode === 0) {
          m.outlineWidthMode = 1;                 /* world coordinates */
          m.outlineWidthFactor = CEL.outline;
          m.outlineColorFactor = new THREE.Color(0x18141f);
        }
        m.needsUpdate = true;
      }
    }
  });
}

/* per-tier knobs. bloom/dof/ssao === null means the pass is skipped. */
const CFG = {
  full:   { ssaa: 1.75, msaa: 4, maxPR: 2,   bloom: { s: .28, r: .5,  t: .85 }, dof: { ap: .00035, blur: .0060 }, ssao: { r: .9, i: 1.1 }, grade: { sharpen: .35, grain: .05, vignette: .32, ca: .0015 } },
  high:   { ssaa: 1.35, msaa: 4, maxPR: 2,   bloom: { s: .25, r: .5,  t: .86 }, dof: { ap: .00030, blur: .0050 }, ssao: null,             grade: { sharpen: .30, grain: .03, vignette: .30, ca: .0012 } },
  medium: { ssaa: 1.0,  msaa: 2, maxPR: 1.5, bloom: { s: .18, r: .45, t: .90 }, dof: null,                        ssao: null,             grade: { sharpen: .0,  grain: .0,  vignette: .25, ca: .0 } },
  low:    { ssaa: 1.0,  msaa: 0, maxPR: 1,   bloom: null,                       dof: null,                        ssao: null,             grade: { sharpen: .0,  grain: .0,  vignette: .20, ca: .0 } },
};

/* display-space grade: unsharp sharpen + vignette + film grain + edge-only
   chromatic aberration. One pass, runs after tone mapping (sRGB space). */
const GradeShader = {
  uniforms: {
    tDiffuse:  { value: null },
    resolution:{ value: new THREE.Vector2(1, 1) },
    frame:     { value: 0 },
    sharpen:   { value: 0 },
    grain:     { value: 0 },
    vignette:  { value: .3 },
    ca:        { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float frame, sharpen, grain, vignette, ca;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main() {
      vec2 px = 1.0 / resolution;
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      /* edge-only chromatic aberration */
      vec3 col;
      if (ca > 0.0) {
        vec2 off = d * ca * 4.0;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - off).b;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }
      /* unsharp mask: 4-neighbour high-pass */
      if (sharpen > 0.0) {
        vec3 blur = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb
                  + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb
                  + texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb
                  + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb;
        col += (col - blur * 0.25) * sharpen;
      }
      /* vignette */
      col *= 1.0 - vignette * smoothstep(0.15, 0.75, r2);
      /* film grain (animated by frame counter, no smooth banding) */
      if (grain > 0.0) {
        float n = hash(vUv * resolution + frame) - 0.5;
        col += n * grain;
      }
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

function detectTier() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'low';
  const mem = (navigator && navigator.deviceMemory) || 8;
  const cores = (navigator && navigator.hardwareConcurrency) || 8;
  if (mem <= 4 || cores <= 4) return 'medium';
  return 'full';
}

/* explicit override wins: ?fx=<tier> > localStorage('lyra-fx') > auto-detect */
export function initialTier() {
  try {
    const q = new URLSearchParams(location.search).get('fx');
    if (q && TIERS.includes(q)) return q;
    const ls = localStorage.getItem('lyra-fx');
    if (ls && TIERS.includes(ls)) return ls;
  } catch (e) {}
  return detectTier();
}

export class PostFX {
  constructor(renderer, scene, camera, tier) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tier = TIERS.includes(tier) ? tier : 'full';
    this.userPinned = false;         /* true once a human picks a tier: kills adaptive */
    this.composer = null;
    this.passes = {};
    this._frame = 0;
    this._size = { w: 1, h: 1, pr: 1 };
    this._fpsAvg = 60; this._fpsT = 0;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this._build();
  }

  _dispose() {
    if (this.composer) { try { this.composer.dispose(); } catch (e) {} }
    this.composer = null; this.passes = {};
  }

  _build() {
    this._dispose();
    if (this.tier === 'off') { this.renderer.toneMapping = THREE.NoToneMapping; return; }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const cfg = CFG[this.tier];
    const { w, h, pr } = this._size;
    try {
      const rt = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        samples: cfg.msaa,
        colorSpace: THREE.NoColorSpace,
      });
      const composer = new EffectComposer(this.renderer, rt);
      composer.setPixelRatio(Math.min(cfg.maxPR, pr) * cfg.ssaa);
      composer.setSize(w, h);

      composer.addPass(new RenderPass(this.scene, this.camera));

      if (cfg.ssao) {
        const ssao = new SSAOPass(this.scene, this.camera, w, h);
        ssao.kernelRadius = cfg.ssao.r; ssao.minDistance = .002; ssao.maxDistance = .12;
        ssao.output = SSAOPass.OUTPUT.Default;
        this.passes.ssao = ssao; composer.addPass(ssao);
      }
      if (cfg.bloom) {
        const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), cfg.bloom.s, cfg.bloom.r, cfg.bloom.t);
        this.passes.bloom = bloom; composer.addPass(bloom);
      }
      if (cfg.dof) {
        const dof = new BokehPass(this.scene, this.camera, {
          focus: 2.4, aperture: cfg.dof.ap, maxblur: cfg.dof.blur,
        });
        this.passes.dof = dof; composer.addPass(dof);
      }

      composer.addPass(new OutputPass());       /* ACES tonemap + sRGB */

      const grade = new ShaderPass(GradeShader);
      grade.uniforms.sharpen.value = cfg.grade.sharpen;
      grade.uniforms.grain.value = cfg.grade.grain;
      grade.uniforms.vignette.value = cfg.grade.vignette;
      grade.uniforms.ca.value = cfg.grade.ca;
      this.passes.grade = grade; composer.addPass(grade);

      if (cfg.msaa === 0) composer.addPass(new SMAAPass(w, h));   /* cheap AA for low tier */

      this.composer = composer;
      this.setSize(w, h, pr);
    } catch (e) {
      console.warn('[lyra] post-fx unavailable, falling back to direct render:', e);
      this.tier = 'off'; this._dispose();
      this.renderer.toneMapping = THREE.NoToneMapping;
    }
  }

  setTier(tier, pin = true) {
    if (!TIERS.includes(tier) || tier === this.tier) { if (pin) this.userPinned = true; return; }
    this.tier = tier;
    if (pin) { this.userPinned = true; try { localStorage.setItem('lyra-fx', tier); } catch (e) {} }
    this._build();
  }

  setSize(w, h, pr) {
    this._size = { w, h, pr };
    if (!this.composer) return;
    const cfg = CFG[this.tier];
    this.composer.setPixelRatio(Math.min(cfg.maxPR, pr) * cfg.ssaa);
    this.composer.setSize(w, h);
    const rw = w * Math.min(cfg.maxPR, pr) * cfg.ssaa, rh = h * Math.min(cfg.maxPR, pr) * cfg.ssaa;
    if (this.passes.bloom) this.passes.bloom.setSize(rw, rh);
    if (this.passes.ssao && this.passes.ssao.setSize) this.passes.ssao.setSize(rw, rh);
    if (this.passes.dof && this.passes.dof.setSize) this.passes.dof.setSize(rw, rh);
    if (this.passes.grade) this.passes.grade.uniforms.resolution.value.set(rw, rh);
  }

  /* keep the character crisp: focus DOF on the head each frame */
  setFocusDistance(d) {
    const dof = this.passes.dof;
    if (dof && dof.uniforms && dof.uniforms.focus) dof.uniforms.focus.value = d;
  }

  /* adaptive: sustained low fps steps the tier down once (never past a human pick) */
  sampleFps(dt) {
    if (this.userPinned || this.tier === 'off' || this.tier === 'low') return;
    const fps = dt > 0 ? 1 / dt : 60;
    this._fpsAvg += (fps - this._fpsAvg) * 0.05;
    this._fpsT += dt;
    if (this._fpsT > 4 && this._fpsAvg < 40) {
      const i = TIERS.indexOf(this.tier);
      this.tier = TIERS[Math.max(1, i - 1)];
      this._fpsT = 0; this._fpsAvg = 60;
      console.info('[lyra] fps low, stepping post-fx down to', this.tier);
      this._build();
    }
  }

  render(dt) {
    this._frame = (this._frame + 1) % 4096;
    if (this.passes.grade) this.passes.grade.uniforms.frame.value = this._frame;
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
