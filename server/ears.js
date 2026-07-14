/* Sensory feedback loop, server side.
   The browser streams compact prosody frames ({rms, pitch, voiced} at ~20 Hz)
   over a WebSocket. This engine turns them into semantic cues:

     user_speaking / user_stopped  -> turn-taking + auto barge-in
     backchannel                   -> periodic "I'm listening" nods
     laugh                         -> burst-rhythm + raised-pitch heuristic
     sigh                          -> long falling-pitch voiced segment
     loud / soft                   -> energy relative to adaptive noise floor
     silence                       -> long in-conversation silence (tension)

   Cues are pushed back to the client for instant avatar reactions, and kept
   in a ring buffer so /api/chat can hand the LLM paralinguistic context.
   These are prosody heuristics, not a trained SER model; the swap point for
   a real model (or an external ASR/emotion stack) is exactly this file.    */
import { WebSocketServer } from 'ws';

export const recentCues = [];
function remember(cue) {
  recentCues.push(cue);
  const cutoff = Date.now() - 30000;
  while (recentCues.length && recentCues[0].ts < cutoff) recentCues.shift();
}

export function summarizeCues(windowMs = 15000) {
  const now = Date.now();
  const cues = recentCues.filter(c => now - c.ts < windowMs);
  if (!cues.length) return '';
  const has = t => cues.some(c => c.type === t);
  const parts = [];
  if (has('laugh')) parts.push('the user laughed');
  if (has('sigh')) parts.push('the user sighed');
  if (has('loud')) parts.push('the user sounded loud or excited');
  if (has('soft')) parts.push('the user spoke very softly');
  if (has('silence')) parts.push('there was a long silence before this message');
  if (!parts.length) return '';
  return '[heard through the mic: ' + parts.join('; ') + ']';
}

class CueEngine {
  constructor(emit) {
    this.emit = emit;
    this.floor = 0.006;         /* adaptive noise floor */
    this.voiced = false;
    this.seg = null;            /* current voiced segment */
    this.segs = [];             /* recent finished segments (laugh window) */
    this.pitchEMA = 180;        /* speaker pitch baseline */
    this.lastVoice = Date.now();
    this.silenceFired = false;
    this.userSpeaking = false;
    this.speakTick = 0;
    this.cool = {};
  }

  cue(type, conf, cooldown = 3000) {
    const now = Date.now();
    if (now - (this.cool[type] || 0) < cooldown) return;
    this.cool[type] = now;
    const c = { type, conf: Math.round(conf * 100) / 100, ts: now };
    remember(c);
    this.emit(c);
  }

  push(f) {
    const now = Date.now();
    const rms = Number(f.rms) || 0;
    const pitch = Number(f.pitch) || 0;
    /* frame tagged "avatar is speaking": her voice leaks from the speakers,
       so demand a much stronger signal and don't let it poison the floor */
    const spk = !!f.spk;

    /* adaptive floor tracks the quiet parts of the room */
    if (!spk && rms < this.floor * 2.5) this.floor = this.floor * 0.995 + rms * 0.005;
    this.floor = Math.max(this.floor, 0.0015);

    const voiced = pitch > 0 && rms > this.floor * (spk ? 9 : 3);

    if (voiced) {
      this.lastVoice = now;
      this.silenceFired = false;
      if (!this.seg) this.seg = { s: now, rmsSum: 0, n: 0, p0: pitch, pEnd: pitch, pSum: 0 };
      this.seg.rmsSum += rms; this.seg.pSum += pitch; this.seg.pEnd = pitch; this.seg.n++;
      const segDur = now - this.seg.s;

      if (!this.userSpeaking && segDur > (spk ? 500 : 250)) {
        this.userSpeaking = true;
        this.speakTick = now;
        this.cue('user_speaking', 1, 800);
      }
      if (this.userSpeaking && now - this.speakTick > 2600) {
        this.speakTick = now;
        this.cue('backchannel', .6, 2000);
      }
      if (rms > this.floor * 11) this.cue('loud', Math.min(1, rms / (this.floor * 16)), 4500);
    } else {
      if (this.seg) this._finishSegment(now);
      if (this.userSpeaking && now - this.lastVoice > 600) {
        this.userSpeaking = false;
        this.cue('user_stopped', 1, 500);
      }
      /* tense silence: conversation existed recently, then nothing for 9s */
      if (!this.silenceFired && now - this.lastVoice > 9000 && now - this.lastVoice < 90000) {
        this.silenceFired = true;
        this.cue('silence', .8, 22000);
      }
    }
    this.voiced = voiced;
  }

  _finishSegment(now) {
    const seg = this.seg; this.seg = null;
    const dur = now - seg.s;
    if (dur < 40 || !seg.n) return;
    const meanRms = seg.rmsSum / seg.n;
    const meanPitch = seg.pSum / seg.n;

    /* long clear speech updates the pitch baseline */
    if (dur > 450) this.pitchEMA = this.pitchEMA * .85 + meanPitch * .15;

    this.segs.push({ e: now, dur, meanPitch, meanRms, p0: seg.p0, pEnd: seg.pEnd });
    const cutoff = now - 1900;
    this.segs = this.segs.filter(s => s.e > cutoff);

    /* laugh: several short raised-pitch bursts in quick rhythm (ha-ha-ha) */
    const bursts = this.segs.filter(s => s.dur >= 60 && s.dur <= 330 && s.meanPitch > this.pitchEMA * 1.12);
    if (bursts.length >= 3) this.cue('laugh', Math.min(1, bursts.length / 4), 3500);

    /* sigh: one long voiced fall in pitch at moderate energy */
    if (dur >= 600 && dur <= 2300 && seg.pEnd < seg.p0 * .82 && meanRms < this.floor * 9)
      this.cue('sigh', .7, 9000);

    /* sustained very soft speech */
    if (dur >= 900 && meanRms < this.floor * 4.5) this.cue('soft', .6, 8000);
  }
}

/* noServer mode: a single upgrade router in index.js dispatches by pathname.
   (Attaching multiple {server,path} WebSocketServers to one http server makes
   the first-registered one abort every non-matching upgrade with HTTP 400.) */
export function attachEars(verifyClient) {
  const wss = new WebSocketServer({ noServer: true, verifyClient });
  wss.on('connection', ws => {
    const engine = new CueEngine(cue => {
      try { ws.send(JSON.stringify(cue)); } catch (e) {}
    });
    ws.on('message', data => {
      try {
        const m = JSON.parse(data);
        (m.frames || []).forEach(f => engine.push(f));
      } catch (e) {}
    });
  });
  return wss;
}
