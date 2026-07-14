/* Sensory feedback loop, client side.
   Extracts prosody features from the ambient mic (RMS energy + pitch via
   autocorrelation), streams compact frames to the backend cue engine, and
   maps returned cues onto instant avatar reactions: reacting WHILE the
   user makes sound, not after the text arrives. */

function detectPitch(buf, sr) {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < .004) return { rms, pitch: 0 };
  const minLag = Math.floor(sr / 400), maxLag = Math.min(buf.length - 1, Math.floor(sr / 70));
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = 0; i < buf.length - lag; i++) c += buf[i] * buf[i + lag];
    if (c > best) { best = c; bestLag = lag; }
  }
  let norm = 0;
  for (let i = 0; i < buf.length; i++) norm += buf[i] * buf[i];
  const conf = norm ? best / norm : 0;
  return { rms, pitch: conf > .35 && bestLag ? sr / bestLag : 0 };
}

export class Ears {
  constructor(avatar, hooks) {
    this.avatar = avatar;
    this.hooks = hooks || {};
    /* while the avatar speaks, frames are tagged so the cue engine demands a
       much louder, longer signal before believing the user is talking (echo) */
    this.isAvatarSpeaking = this.hooks.isAvatarSpeaking || (() => false);
    this.running = false;
    this.ws = null; this.stream = null; this.ctx = null;
    this.frames = [];
  }

  async start() {
    if (this.running) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false },
      });
    } catch (e) {
      this.hooks.onError && this.hooks.onError('Mic permission denied for ambient listening.');
      return false;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const sr = this.ctx.sampleRate;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(proto + '://' + location.host + '/ears');
    this.ws.onmessage = e => {
      try { this.react(JSON.parse(e.data)); } catch (err) {}
    };
    this.ws.onerror = () => {};

    this.sampleTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const f = detectPitch(buf, sr);
      this.frames.push({ rms: +f.rms.toFixed(4), pitch: Math.round(f.pitch), spk: this.isAvatarSpeaking() ? 1 : 0 });
    }, 50);
    this.sendTimer = setInterval(() => {
      if (this.frames.length && this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ frames: this.frames.splice(0) }));
      } else this.frames.length = 0;
    }, 120);

    this.running = true;
    return true;
  }

  stop() {
    this.running = false;
    clearInterval(this.sampleTimer); clearInterval(this.sendTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (e) {} this.ctx = null; }
  }

  /* cue -> instant reaction. These never touch the conversation state
     machine; they layer micro-behavior on top of whatever is running. */
  react(cue) {
    const a = this.avatar;
    switch (cue.type) {
      case 'laugh':
        a.microExpression('happy', .85, 1.4);
        a.bobPulse();
        this.hooks.onFx && this.hooks.onFx('sparkle');
        break;
      case 'sigh':
        a.microExpression('sad', .4, 1.8);
        a.proceduralGesture('tilt');
        break;
      case 'loud':
        a.microExpression('surprised', .6, 1.0);
        break;
      case 'soft':
        a.microLean(1.6);
        a.microExpression('relaxed', .35, 1.6);
        break;
      case 'silence':
        /* acknowledge the tension: weight shift, head tilt, faint smile */
        a.micro.shoulderT = 1.4;
        a.micro.weightTgt = (Math.random() - .5) * .022;
        a.proceduralGesture('tilt');
        a.microExpression('relaxed', .3, 2.0);
        break;
      case 'backchannel':
        /* occasionally a real mocap acknowledgement instead of a micro nod */
        if (Math.random() < .3 && this.hooks.onBackchannel && this.hooks.onBackchannel()) break;
        a.microNod(.7);
        a.microExpression('relaxed', .25, .8);
        break;
      case 'user_speaking':
        a.microLean(1.2);
        this.hooks.onUserSpeaking && this.hooks.onUserSpeaking(cue);
        break;
      case 'user_stopped':
        this.hooks.onUserStopped && this.hooks.onUserStopped(cue);
        break;
    }
  }
}
