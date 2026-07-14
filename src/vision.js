/* Vision sense: she can see you.
   - Frame capture: one downscaled webcam frame every few seconds goes to
     /api/vision (vision-capable LLM) -> {note, expression, proximity}.
     The note rides into the next chat turn; expression/proximity trigger
     instant subconscious reactions. Frames are analyzed and discarded.
   - Gaze: when the browser has FaceDetector (Chrome flag / some builds),
     your face position is tracked several times a second and her eyes
     follow you around the frame. Degrades silently when unavailable. */

const FRAME_EVERY_MS = 5000;
const GAZE_EVERY_MS = 300;

export class VisionSense {
  constructor(hooks) {
    this.h = hooks;   /* {onVision({note,expression,proximity}), onGaze(nx,ny), onError(msg)} */
    this.running = false;
    this.stream = null; this.video = null;
    this.frameTimer = 0; this.gazeTimer = 0;
    this.busy = false;
    this.detector = null;
    this.lastNote = ''; this.lastExpression = 'neutral'; this.lastAt = 0;
  }

  get note() { return Date.now() - this.lastAt < 20000 ? this.lastNote : ''; }

  async start() {
    if (this.running) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      });
    } catch (e) { this.h.onError && this.h.onError('Camera permission denied.'); return false; }
    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true; this.video.playsInline = true;
    await this.video.play().catch(() => {});
    this.canvas = document.createElement('canvas');
    this.running = true;

    /* face tracking for gaze following, when the platform has it */
    try {
      if (window.FaceDetector) {
        this.detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        this.gazeTimer = setInterval(() => this._gaze(), GAZE_EVERY_MS);
      }
    } catch (e) { this.detector = null; }

    this.frameTimer = setInterval(() => this._frame(), FRAME_EVERY_MS);
    setTimeout(() => this._frame(), 1200);   /* first look comes quickly */
    return true;
  }

  stop() {
    this.running = false;
    clearInterval(this.frameTimer); clearInterval(this.gazeTimer);
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video = null; this.lastNote = '';
  }

  _grab(w) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return null;
    const k = w / vw;
    this.canvas.width = w; this.canvas.height = Math.round(vh * k);
    this.canvas.getContext('2d').drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/jpeg', .75);
  }

  async _frame() {
    if (!this.running || this.busy) return;
    const url = this._grab(512);
    if (!url) return;
    this.busy = true;
    try {
      const r = await fetch('/api/vision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: url.slice(url.indexOf(',') + 1) }),
      });
      const j = await r.json();
      if (j.error) { this.h.onError && this.h.onError(j.error); this.stop(); return; }
      this.lastNote = j.note; this.lastExpression = j.expression; this.lastAt = Date.now();
      this.h.onVision && this.h.onVision(j);
    } catch (e) { /* transient: try again next tick */ }
    finally { this.busy = false; }
  }

  async _gaze() {
    if (!this.running || !this.detector || !this.video.videoWidth) return;
    try {
      const faces = await this.detector.detect(this.video);
      if (!faces.length) return;
      const b = faces[0].boundingBox;
      /* normalized -1..1; webcam is mirrored so flip x for "follow you" */
      const nx = -(((b.x + b.width / 2) / this.video.videoWidth) * 2 - 1);
      const ny = -(((b.y + b.height / 2) / this.video.videoHeight) * 2 - 1);
      this.h.onGaze && this.h.onGaze(nx, ny);
    } catch (e) { /* detector hiccup: ignore */ }
  }
}
