/* Hands-free call loop: the mic is always open, no push-to-talk.
   Web Speech API runs in continuous mode with a restart watchdog (it dies
   silently after a few minutes); VAD cues from ears.js drive endpointing —
   an utterance is committed after ~900ms of post-speech quiet.

   Echo gating: while the avatar is speaking, recognition results are only
   accepted if the VAD confirmed *user* speech recently (the VAD mic stream
   runs with echoCancellation, so her own voice through the speakers doesn't
   register as user speech). That's what makes open-mic + open-speakers
   workable; headphones make it perfect.                                   */

const COMMIT_MS = 900;        /* quiet time that ends an utterance */
const VAD_FRESH_MS = 1800;    /* how recent a VAD voice cue must be to accept STT while she talks */

export class CallLoop {
  constructor(opts) {
    this.o = opts;   /* {lang(), onUtterance(text), onInterim(text), onState(on), onError(msg), isAvatarSpeaking()} */
    this.engine = 'webspeech';   /* or 'deepgram' — set from /api/health before start() */
    this.running = false;
    this.muted = false;
    this.rec = null;
    this.buffer = '';
    this.commitTimer = 0;
    this.restartTimer = 0;
    this.lastVadVoice = 0;
    this.startedAt = 0;
    this.media = null; this.ws = null; this.recorder = null;   /* deepgram path */
  }

  get elapsed() { return this.running ? (Date.now() - this.startedAt) / 1000 : 0; }

  start() {
    if (this.running) return true;
    if (this.engine === 'deepgram') { this._startDeepgram(); return true; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.o.onError('Voice calls need Chrome/Edge (Web Speech API).'); return false; }
    this.running = true;
    this.startedAt = Date.now();
    this.buffer = '';
    this._spin(SR);
    this.o.onState(true);
    return true;
  }

  stop() {
    this.running = false;
    clearTimeout(this.commitTimer); clearTimeout(this.restartTimer);
    this.buffer = '';
    if (this.rec) { try { this.rec.onend = null; this.rec.stop(); } catch (e) {} this.rec = null; }
    this._stopDeepgram();
    this.o.onState(false);
  }

  /* ---------------- Deepgram engine (cloud STT via the /stt relay) ---------------- */
  async _startDeepgram() {
    try {
      this.media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) { this.o.onError('Mic permission denied.'); return; }
    this.running = true;
    this.startedAt = Date.now();
    this.buffer = '';
    this._spinDg();
    this.o.onState(true);
  }

  _spinDg() {
    if (!this.running) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = this.ws = new WebSocket(proto + '://' + location.host + '/stt?lang=' + encodeURIComponent(this.o.lang()));
    ws.onopen = () => {
      try {
        const rec = this.recorder = new MediaRecorder(this.media, { mimeType: 'audio/webm;codecs=opus' });
        rec.ondataavailable = e => { if (e.data.size && ws.readyState === 1) ws.send(e.data); };
        rec.start(250);
      } catch (e) { this.o.onError('Recorder failed: ' + e.message); this.stop(); }
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.error) { this.o.onError(m.error); return; }
      if (!this._accept()) return;
      if (m.text) {
        if (m.isFinal) { this.buffer += m.text + ' '; this.o.onInterim(this.buffer.trim()); }
        else this.o.onInterim((this.buffer + ' ' + m.text).trim());
      }
      /* deepgram's own endpointing beats the local debounce when it fires */
      if (m.speechFinal && this.buffer.trim()) this._scheduleCommit(120);
      else if (m.isFinal && this.buffer.trim()) this._scheduleCommit();
    };
    ws.onclose = () => {
      if (!this.running) return;
      if (this.recorder) { try { this.recorder.stop(); } catch (e) {} this.recorder = null; }
      this.restartTimer = setTimeout(() => this._spinDg(), 600);
    };
    ws.onerror = () => {};
  }

  _stopDeepgram() {
    if (this.recorder) { try { this.recorder.stop(); } catch (e) {} this.recorder = null; }
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.media) { this.media.getTracks().forEach(t => t.stop()); this.media = null; }
  }

  setMuted(m) { this.muted = m; if (m) { this.buffer = ''; this.o.onInterim(''); } }

  /* VAD cues from ears.js */
  noteUserSpeaking() {
    this.lastVadVoice = Date.now();
    clearTimeout(this.commitTimer);          /* still talking: hold the commit */
  }
  noteUserStopped() {
    if (this.buffer.trim()) this._scheduleCommit(500);
  }

  _accept() {
    if (!this.running || this.muted) return false;
    /* echo gate: while she speaks, require VAD-confirmed user speech */
    if (this.o.isAvatarSpeaking() && Date.now() - this.lastVadVoice > VAD_FRESH_MS) return false;
    return true;
  }

  _scheduleCommit(ms = COMMIT_MS) {
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      const text = this.buffer.trim();
      this.buffer = '';
      this.o.onInterim('');
      if (text) this.o.onUtterance(text);
    }, ms);
  }

  _spin(SR) {
    if (!this.running) return;
    let rec;
    try { rec = new SR(); } catch (e) { this.o.onError('Mic unavailable.'); this.stop(); return; }
    this.rec = rec;
    rec.lang = this.o.lang();
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = e => {
      if (!this._accept()) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.buffer += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      this.o.onInterim((this.buffer + interim).trim());
      this._scheduleCommit();
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.o.onError('Mic permission denied.');
        this.stop();
      }
      /* no-speech / network / aborted: the watchdog restarts */
    };
    rec.onend = () => {
      if (!this.running) return;
      /* continuous recognition dies periodically: restart quietly */
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this._spin(SR), 250);
    };
    try { rec.start(); } catch (e) {
      this.restartTimer = setTimeout(() => this._spin(SR), 800);
    }
  }
}
