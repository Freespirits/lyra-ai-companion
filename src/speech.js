/* Acoustic channel: audio playback + viseme timing + STT primitives.
   Priority for mouth timing:
     1. word marks from the server (ElevenLabs char timestamps, exact)
     2. word boundary events (browser TTS)
     3. estimated schedule from text + live audio-energy jaw       */

const VISMAP = { AA: { n: 'aa', v: 1 }, IH: { n: 'ih', v: .85 }, EE: { n: 'ee', v: .85 }, OH: { n: 'oh', v: .9 }, OU: { n: 'ou', v: .9 }, CONS: { n: 'aa', v: .3 }, FV: { n: 'ih', v: .35 } };

function charToViseme(c) {
  c = c.toLowerCase();
  if ('a@'.includes(c)) return 'AA';
  if ('iy'.includes(c)) return 'IH';
  if (c === 'e') return 'EE';
  if (c === 'o') return 'OH';
  if ('uw'.includes(c)) return 'OU';
  if ('mbp'.includes(c)) return 'MM';
  if ('fv'.includes(c)) return 'FV';
  if ('lntdszrjkgcqxh'.includes(c)) return 'CONS';
  return null;
}
function visemesFor(word) {
  const seq = []; let prev = null;
  for (const c of word) { const v = charToViseme(c); if (v && v !== prev) { seq.push(v); prev = v; } }
  if (!seq.length) seq.push('CONS');
  if (seq.length > 6) { const out = []; for (let i = 0; i < 6; i++) out.push(seq[Math.floor(i * seq.length / 6)]); return out; }
  return seq;
}

export const lip = {
  sched: [],
  spoken: [],   /* words confirmed spoken (marks / boundary events) */
  plan: [],     /* words with estimated start times (fallback path) */
  speakWord(word, rate = 1) {
    const now = performance.now(), seq = visemesFor(word);
    this.spoken.push(word);
    const dur = Math.min(900, (word.length * 68 + 50) / rate);
    const per = Math.max(45, Math.min(150, dur / seq.length));
    let t = now;
    for (const v of seq) { this.sched.push({ s: t, e: t + per, vis: v }); t += per; }
  },
  scheduleAll(text, rate = 1) {
    let t = performance.now() + 80;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      this.plan.push({ t, word });
      const seq = visemesFor(word);
      const dur = Math.min(900, (word.length * 68 + 50) / rate);
      const per = Math.max(45, Math.min(150, dur / seq.length));
      for (const v of seq) { this.sched.push({ s: t, e: t + per, vis: v }); t += per; }
      t += 70;
    }
    return t;
  },
  /* what has actually been said so far, for interrupt annotation */
  getSpoken() {
    const now = performance.now();
    const est = this.plan.filter(p => p.t <= now).map(p => p.word);
    return (this.spoken.length ? this.spoken : est).join(' ');
  },
  current() {
    const now = performance.now();
    while (this.sched.length && this.sched[0].e < now) this.sched.shift();
    const cur = this.sched.find(x => x.s <= now && now < x.e);
    return cur ? VISMAP[cur.vis] || null : null;
  },
  clear() { this.sched = []; this.spoken = []; this.plan = []; },
};

/* ---------------- audio playback ---------------- */
let audioCtx = null, currentAudio = null;

/* Play one synthesized segment. data = {format, audio(base64), marks[]}.
   onWord fires per confirmed word (captions), done() when playback ends. */
export function playAudio(data, text, avatar, done, onWord) {
  const audio = currentAudio = new Audio('data:audio/' + (data.format || 'mp3') + ';base64,' + data.audio);
  const marks = data.marks || [];
  let idx = 0, raf = 0, watchdog = 0, finished = false;
  const fin = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf); clearTimeout(watchdog);
    avatar.jaw = 0;
    done();
  };
  /* never let a stalled element wedge the segment queue */
  const arm = () => {
    clearTimeout(watchdog);
    const ms = isFinite(audio.duration) && audio.duration > 0
      ? audio.duration * 1000 + 2500
      : text.length * 95 + 5000;
    watchdog = setTimeout(() => { try { audio.pause(); } catch (e) {} fin(); }, ms);
  };
  audio.addEventListener('loadedmetadata', arm);
  arm();

  /* audio-energy jaw as a safety net. IMPORTANT: the audible path stays on the
     plain <audio> element — Chrome's echoCancellation can only cancel that, not
     WebAudio output. Analysis taps a silent captureStream() copy instead, so
     her voice through the speakers doesn't feed back into the mic pipeline. */
  let an = null, buf = null;
  try {
    const cap = audio.captureStream || audio.mozCaptureStream;
    if (cap) {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const src = audioCtx.createMediaStreamSource(cap.call(audio));
      an = audioCtx.createAnalyser(); an.fftSize = 512;
      src.connect(an);                 /* analysis only: never to destination */
      buf = new Uint8Array(an.frequencyBinCount);
    }
  } catch (e) { an = null; }
  const pump = () => {
    if (audio !== currentAudio || finished) return;
    if (an) {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
      avatar.jaw = Math.min(1, Math.sqrt(sum / buf.length) * 6);
    }
    /* fire word marks aligned to playback clock */
    while (idx < marks.length && marks[idx].t <= audio.currentTime + .02) {
      lip.speakWord(marks[idx].word); avatar.bobPulse();
      if (onWord) onWord(marks[idx].word, idx);
      idx++;
    }
    raf = requestAnimationFrame(pump);
  };
  pump();
  if (!marks.length) lip.scheduleAll(text);

  audio.onended = fin;
  audio.onerror = fin;
  audio.play().catch(() => { lip.scheduleAll(text); setTimeout(fin, text.length * 70); });
  return audio;
}

export function browserSpeak(text, avatar, done, onWord) {
  const synth = window.speechSynthesis;
  if (!synth) { const end = lip.scheduleAll(text); setTimeout(done, Math.max(300, end - performance.now())); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find(x => /female|aria|jenny|zira|samantha/i.test(x.name) && x.lang.indexOf('en') === 0);
  if (v) u.voice = v;
  u.pitch = 1.12;
  let gotBoundary = false, finished = false, wi = 0;
  const finish = () => { if (finished) return; finished = true; done(); };
  u.onboundary = e => {
    if (typeof e.charIndex !== 'number') return;
    gotBoundary = true;
    const m = text.slice(e.charIndex).match(/^\S+/);
    if (m) { lip.speakWord(m[0]); avatar.bobPulse(); if (onWord) onWord(m[0], wi++); }
  };
  u.onstart = () => setTimeout(() => { if (!gotBoundary && !finished) lip.scheduleAll(text); }, 450);
  u.onend = finish; u.onerror = finish;
  synth.speak(u);
  setTimeout(finish, Math.max(4000, text.length * 120));
}

export function stopSpeaking() {
  const spoken = lip.getSpoken();
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  lip.clear();
  return spoken;
}

/* one-shot low-volume clip (think-gap fillers); independent of the segment player */
export function playClip(data, volume = .55) {
  try {
    const a = new Audio('data:audio/' + (data.format || 'mp3') + ';base64,' + data.audio);
    a.volume = volume;
    a.play().catch(() => {});
    return a;
  } catch (e) { return null; }
}

/* ---------------- STT (single-utterance, manual mode) ---------------- */
export function makeMic(lang, onText, onState, onError) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  const stop = () => {
    listening = false; onState(false);
    if (rec) { try { rec.stop(); } catch (e) {} rec = null; }
  };
  const start = () => {
    if (!SR) { onError('Speech recognition needs Chrome/Edge. Type instead.'); return; }
    try {
      rec = new SR();
      rec.lang = lang(); rec.interimResults = true; rec.continuous = false;
      rec.onresult = e => {
        let fin = '', inter = '';
        for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else inter += r[0].transcript; }
        onText(fin || inter, !!fin);
        if (fin) stop();
      };
      rec.onerror = e => { stop(); onError('Mic error: ' + e.error); };
      rec.onend = () => { if (listening) stop(); };
      rec.start();
      listening = true; onState(true);
    } catch (e) { onError('Mic unavailable.'); stop(); }
  };
  return { toggle: () => (listening ? stop() : start()), stop, get listening() { return listening; } };
}
