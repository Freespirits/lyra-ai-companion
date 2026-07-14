/* Streaming reply pipeline, client side.
   streamChat() consumes the server's NDJSON event stream; SegmentPlayer
   plays synthesized segments strictly in order while later ones are still
   being generated, driving visemes, captions, and mood along the way. */
import { lip, playAudio, browserSpeak, stopSpeaking } from './speech.js';

export async function streamChat({ messages, turnId, onEvent }) {
  const res = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, turnId }),
  });
  if (!res.ok || !res.body) throw new Error('API ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      onEvent(ev);
    }
  }
}

/* Ordered playback: segment i never plays before i-1 finished, but its audio
   may arrive in any order (server synthesizes concurrently). */
export class SegmentPlayer {
  constructor(avatar, hooks) {
    this.avatar = avatar;
    this.hooks = hooks || {};   /* onSegStart(seg), onWord(word,i), onSegEnd(seg), onAllDone() */
    this.reset();
  }
  reset() {
    this.entries = new Map();   /* i -> {seg, audio: undefined=pending | null=none | data} */
    this.next = 0;
    this.playingIdx = -1;
    this.noMore = false;
    this.stopped = false;
    this.started = false;
    this.spokenParts = [];
  }
  addSeg(seg) {
    const e = this.entries.get(seg.i) || {};
    e.seg = seg;
    if (!seg.tts && e.audio === undefined) e.audio = null;
    this.entries.set(seg.i, e);
    this._pump();
  }
  addAudio(i, data) {
    const e = this.entries.get(i) || {};
    e.audio = (data && data.audio) ? data : null;
    this.entries.set(i, e);
    this._pump();
  }
  finish() {
    this.noMore = true;
    /* if a synthesis result never arrives (mid-stream error), don't hang the
       queue forever: give it a grace window then fall back to browser TTS */
    setTimeout(() => {
      if (this.stopped) return;
      for (const e of this.entries.values()) if (e.seg && e.audio === undefined) e.audio = null;
      this._pump();
    }, 12000);
    this._pump();
  }
  get active() { return this.playingIdx >= 0; }

  _pump() {
    if (this.stopped || this.playingIdx >= 0) return;
    const e = this.entries.get(this.next);
    if (!e || !e.seg) {
      if (this.noMore && !e) this._allDone();
      return;
    }
    if (e.seg.tts && e.audio === undefined) return;   /* synthesis still in flight */
    const i = this.next;
    this.playingIdx = i;
    if (!this.started) { this.started = true; this.avatar.speaking = true; }
    if (this.hooks.onSegStart) this.hooks.onSegStart(e.seg);
    const done = () => {
      if (this.stopped || this.playingIdx !== i) return;
      this.spokenParts.push(e.seg.caption);
      lip.clear();
      this.playingIdx = -1;
      this.next = i + 1;
      if (this.hooks.onSegEnd) this.hooks.onSegEnd(e.seg);
      this._pump();
      if (this.playingIdx < 0 && this.noMore && !this.entries.get(this.next)) this._allDone();
    };
    const onWord = (w, wi) => { if (this.hooks.onWord) this.hooks.onWord(w, wi, e.seg); };
    if (e.audio) playAudio(e.audio, e.seg.caption, this.avatar, done, onWord);
    else browserSpeak(e.seg.caption, this.avatar, done, onWord);
  }

  _allDone() {
    if (this.stopped) return;
    this.stopped = true;
    this.avatar.speaking = false; this.avatar.jaw = 0;
    if (this.hooks.onAllDone) this.hooks.onAllDone();
  }

  /* hard stop (barge-in). Returns the text actually spoken so far. */
  stop() {
    if (this.stopped && this.playingIdx < 0) return this.spokenParts.join(' ');
    this.stopped = true;
    const partial = stopSpeaking();
    this.avatar.speaking = false; this.avatar.jaw = 0;
    this.playingIdx = -1;
    const parts = this.spokenParts.slice();
    if (partial) parts.push(partial);
    return parts.join(' ');
  }
}
