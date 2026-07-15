/* Mocap layer: retargets Mixamo FBX clips onto the VRM's normalized humanoid
   rig and blends them through a small state machine with crossfades.
   Retarget math adapted from the MIT-licensed @pixiv/three-vrm Mixamo example. */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { API } from './config.js';

/* Mixamo rig name -> VRM humanoid bone name */
export const MIXAMO_VRM_MAP = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
};

const fbxLoader = new FBXLoader();
const assetCache = new Map();   /* url -> parsed FBX; retarget is per-VRM but the file isn't */

export async function loadMixamoClip(url, vrm) {
  if (!assetCache.has(url)) assetCache.set(url, fbxLoader.loadAsync(url));
  const asset = await assetCache.get(url).catch(e => { assetCache.delete(url); throw e; });
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  if (!clip) throw new Error('no animation in ' + url);

  const tracks = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();

  const mixamoHips = asset.getObjectByName('mixamorigHips');
  const motionHipsHeight = mixamoHips ? mixamoHips.position.y : 100;
  const vrmHipsY = vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(v3).y;
  const vrmRootY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const hipsScale = Math.abs(vrmHipsY - vrmRootY) / motionHipsHeight;
  const flip = vrm.meta && vrm.meta.metaVersion === '0';

  for (const track of clip.tracks) {
    const [rigName, prop] = track.name.split('.');
    const vrmBoneName = MIXAMO_VRM_MAP[rigName];
    const vrmNode = vrmBoneName && vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
    if (!vrmNode) continue;
    const rigNode = asset.getObjectByName(rigName);
    if (!rigNode) continue;

    if (track instanceof THREE.QuaternionKeyframeTrack && prop === 'quaternion') {
      rigNode.getWorldQuaternion(restRotationInverse).invert();
      rigNode.parent.getWorldQuaternion(parentRestWorldRotation);
      const values = Float32Array.from(track.values);
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q.toArray(values, i);
      }
      const out = flip
        ? values.map((x, i) => (i % 2 === 0 ? -x : x)) /* negate x and z components */
        : values;
      tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNode.name}.quaternion`, Array.from(track.times), Array.from(out)));
    } else if (track instanceof THREE.VectorKeyframeTrack && prop === 'position' && vrmBoneName === 'hips') {
      const out = track.values.map((x, i) => (flip && i % 3 !== 1 ? -x : x) * hipsScale);
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNode.name}.position`, Array.from(track.times), Array.from(out)));
    }
  }
  return new THREE.AnimationClip(url.split('/').pop(), clip.duration, tracks);
}

/* ------------------------------------------------------------------ */
/* Which files map to which behavioral state. Drop the FBX files from  */
/* Mixamo into public/animations/ using these exact names (or edit).   */
/* Any missing file is skipped; states without clips fall back to the  */
/* procedural idle layer in avatar.js.                                 */
export const MANIFEST = {
  idle:        ['idle.fbx', 'idle (1).fbx', 'breathing idle.fbx', 'weight shift.fbx', 'idle2.fbx', 'idle3.fbx'],
  happy:       ['happy idle.fbx', 'happy-idle.fbx'],
  sad:         ['sad idle.fbx', 'sad-idle.fbx'],
  listen:      ['standing idle.fbx', 'listen.fbx'],
  think:       ['thinking.fbx', 'think.fbx'],
  talk:        ['talking.fbx', 'talking (1).fbx', 'talk.fbx', 'talk2.fbx'],
  wave:        ['wave.fbx', 'waving.fbx'],
  bounce:      ['happy hand gesture.fbx', 'excited.fbx'],
  agree:       ['head nod yes.fbx', 'lengthy head nod.fbx', 'hard head nod.fbx', 'agree.fbx'],
  shrug:       ['dismissing gesture.fbx', 'shrug.fbx'],
  no:          ['shaking head no.fbx', 'annoyed head shake.fbx'],
  cocky:       ['being cocky.fbx'],
  angry:       ['angry gesture.fbx'],
  lookaway:    ['look away gesture.fbx'],
  sigh:        ['relieved sigh.fbx'],
  acknowledge: ['acknowledging.fbx', 'sarcastic head nod.fbx'],
  dance:       ['hip hop dancing.fbx', 'salsa dancing.fbx', 'samba dancing.fbx'],
  jump:        ['jump.fbx'],
  /* sustained poses (single-frame): held as a base state, not a one-shot */
  lay:         ['female laying pose.fbx', 'female laying pose (1).fbx'],
  crouch:      ['female crouch pose.fbx', 'kneeling idle.fbx'],
  workout:     ['kettlebell swing.fbx'],
  /* kung fu set (Bao the panda) — drop the matching .fbx into public/animations/ */
  bow:         ['standing bow.fbx', 'quick formal bow.fbx', 'bow.fbx'],
  kungfu:      ['kung fu.fbx', 'martial arts kick.fbx', 'roundhouse kick.fbx'],
  stance:      ['fighting idle.fbx', 'kung fu stance.fbx', 'warming up.fbx'],
  meditate:    ['seated meditation.fbx', 'meditating.fbx', 'praying.fbx'],
};

/* poses that should be HELD (she stays down) rather than played once */
export const POSE_STATES = new Set(['lay', 'crouch']);

export class AnimController {
  constructor(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {};        /* state -> [actions] */
    this.base = null;         /* current looping action */
    this.baseState = null;
    this.oneShotAction = null;
    this.variantTimer = 0;
    this.hasMocap = false;
  }

  async load(onProgress) {
    /* resolve manifest names against the real files case-insensitively
       ("Idle.fbx" on disk still fills the "idle.fbx" slot) */
    let onDisk = null;
    try {
      const r = await fetch(API('/api/animations'));
      onDisk = new Map(((await r.json()).files || []).map(f => [f.toLowerCase(), f]));
    } catch (e) { /* no backend: try the manifest names as-is */ }
    const loaded = [], failed = [], missing = [];
    for (const [state, files] of Object.entries(MANIFEST)) {
      this.actions[state] = [];
      for (const f of files) {
        const real = onDisk ? onDisk.get(f.toLowerCase()) : f;
        if (onDisk && !real) { missing.push(f); continue; }
        try {
          const clip = await loadMixamoClip('/animations/' + encodeURIComponent(real), this.vrm);
          const a = this.mixer.clipAction(clip);
          this.actions[state].push(a);
          this.hasMocap = true;
          loaded.push(state + ':' + real);
          if (onProgress) onProgress(f);
        } catch (e) {
          failed.push(real + ' (' + (e && e.message || e) + ')');
          console.warn('[lyra mocap] FAIL', real, '—', (e && e.message) || e);
        }
      }
    }
    /* make silent failures visible: run `window.lyra` then check this in console */
    console.info('[lyra mocap] loaded', loaded.length, 'clips across',
      Object.keys(this.actions).filter(s => this.actions[s].length).length, 'states;',
      failed.length, 'failed,', missing.length, 'files absent on disk');
    if (failed.length) console.warn('[lyra mocap] FAILED to retarget:', failed);
    this.states = () => Object.fromEntries(Object.entries(this.actions).map(([s, a]) => [s, a.length]));
    return this.hasMocap;
  }

  has(state) { return (this.actions[state] || []).length > 0; }

  pick(state) {
    const list = this.actions[state] || [];
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  /* looping base layer with crossfade */
  setBase(state, fade = 0.4) {
    /* Falling back to idle is right for the ambient state, but it used to also
       report success for a state whose clip is missing — so a held gesture like
       [gesture:meditate] with no .fbx played idle and claimed it worked, and the
       caller never reached its procedural fallback. Say so instead. */
    const substituted = !this.has(state);
    const target = substituted ? 'idle' : state;
    const next = this.pick(target);
    if (!next) return false;
    if (this.base === next && this.baseState === target) return !substituted;
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.enabled = true;
    next.fadeIn(fade).play();
    if (this.base && this.base !== next) this.base.fadeOut(fade);
    this.base = next;
    this.baseState = target;                     /* the state actually playing, so variant rotation finds its clips */
    this.variantTimer = 9 + Math.random() * 7;
    return !substituted;
  }

  /* one-shot gesture layered over the base, then fade back */
  oneShot(state, fade = 0.25) {
    const a = this.pick(state);
    if (!a) return false;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.enabled = true;
    a.fadeIn(fade).play();
    if (this.base) this.base.fadeOut(fade);
    this.oneShotAction = a;
    const onDone = (e) => {
      if (e.action !== a) return;
      this.mixer.removeEventListener('finished', onDone);
      a.fadeOut(fade);
      if (this.base) { this.base.reset(); this.base.fadeIn(fade).play(); }
      this.oneShotAction = null;
    };
    this.mixer.addEventListener('finished', onDone);
    return true;
  }

  update(dt) {
    /* rotate between idle variants so long idles never look looped */
    if (this.base && !this.oneShotAction && (this.actions[this.baseState] || []).length > 1) {
      this.variantTimer -= dt;
      if (this.variantTimer <= 0) this.setBase(this.baseState, 0.8);
    }
    this.mixer.update(dt);
  }
}
