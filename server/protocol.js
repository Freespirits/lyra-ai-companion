/* Stream control protocol: the LLM emits plain prose with inline bracket tags.
   Two tag families:
     audio/emotion tags  [laughs] [whispers] [excited] ...  -> kept in the TTS
       text (eleven_v3 renders them as vocal emotion) AND mapped to face mood.
     directive tags      [scene:name] [avatar:name] [gesture:wave]
       -> stripped from the TTS text, emitted as control events.
   This module is pure functions/classes so it can be unit-tested with node. */

export const EMOTIONS = ['neutral', 'happy', 'excited', 'surprised', 'sad', 'thinking'];
export const GESTURES = ['nod', 'tilt', 'wink', 'bounce', 'wave', 'shrug',
  'no', 'cocky', 'angry', 'lookaway', 'sigh', 'dance', 'jump',
  'lay', 'crouch', 'workout',
  'bow', 'stance', 'kungfu', 'meditate'];   /* kung fu set — suits Bao the panda */
/* sustained stances (dynamic affect): unlike mood bursts these persist until changed */
export const AFFECTS = ['neutral', 'teasing', 'focused', 'warm', 'fierce'];

/* audio tag -> mood nudge on the avatar's continuous mood vector */
export const TAG_MOOD = {
  laughs:        { emotion: 'happy',     w: .9 },
  giggles:       { emotion: 'happy',     w: .7 },
  chuckles:      { emotion: 'happy',     w: .5 },
  warmly:        { emotion: 'happy',     w: .5 },
  playfully:     { emotion: 'happy',     w: .6 },
  excited:       { emotion: 'excited',   w: .9 },
  gasps:         { emotion: 'surprised', w: .8 },
  surprised:     { emotion: 'surprised', w: .7 },
  whispers:      { emotion: 'neutral',   w: .4 },
  mischievously: { emotion: 'happy',     w: .6 },
  teasing:       { emotion: 'happy',     w: .5 },
  sarcastic:     { emotion: 'happy',     w: .3 },
  sighs:         { emotion: 'sad',       w: .5 },
  sadly:         { emotion: 'sad',       w: .8 },
  crying:        { emotion: 'sad',       w: 1 },
  curious:       { emotion: 'thinking',  w: .6 },
  thoughtfully:  { emotion: 'thinking',  w: .5 },
  pauses:        { emotion: 'thinking',  w: .3 },
  softly:        { emotion: 'neutral',   w: .3 },
  exhales:       { emotion: 'neutral',   w: .3 },
};
export const AUDIO_TAGS = Object.keys(TAG_MOOD);

const DIRECTIVE_RE = /\[\s*(scene|avatar|gesture|affect)\s*:\s*([\w .-]+?)\s*\]/gi;
const REMEMBER_RE = /\[\s*remember\s*:\s*([^\]\n]{4,220}?)\s*\]/gi;
/* [name:Ori] — she learns what to call you from the conversation itself, rather
   than the app blocking on a native prompt before she has even said hello. */
const NAME_RE = /\[\s*name\s*:\s*([^\]\n]{1,40}?)\s*\]/gi;
const ANY_TAG_RE = /\[[^\[\]\n]{1,240}\]/g;

/* Parse one text segment into TTS text, clean caption, control events, and
   mood nudges. Unknown bracket tags are left for the TTS (v3 improvises well)
   but always stripped from the caption. */
export function parseSegment(text) {
  const events = [];
  let ttsText = String(text).replace(REMEMBER_RE, (m, note) => {
    events.push({ kind: 'remember', name: note.trim() });
    return ' ';
  });
  ttsText = ttsText.replace(NAME_RE, (m, who) => {
    events.push({ kind: 'name', name: who.trim().slice(0, 40) });
    return ' ';
  });
  ttsText = ttsText.replace(DIRECTIVE_RE, (m, kind, name) => {
    kind = kind.toLowerCase(); name = name.trim();
    if (kind === 'gesture') {
      const g = name.toLowerCase();
      if (GESTURES.includes(g)) events.push({ kind, name: g });
    } else if (kind === 'affect') {
      const a = name.toLowerCase();
      if (AFFECTS.includes(a)) events.push({ kind, name: a });
    } else events.push({ kind, name });
    return ' ';
  });

  const mood = [];
  for (const m of ttsText.matchAll(ANY_TAG_RE)) {
    const tag = m[0].slice(1, -1).trim().toLowerCase();
    const t = TAG_MOOD[tag];
    if (t) mood.push({ emotion: t.emotion, w: t.w });
  }

  ttsText = ttsText.replace(/\s{2,}/g, ' ').trim();
  const caption = ttsText.replace(ANY_TAG_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?…;:])/g, '$1')   /* "you are ." -> "you are." after tag removal */
    .trim();
  return { ttsText, caption, events, mood };
}

/* strip every bracket tag: for TTS providers that can't render them (edge) */
export function stripAllTags(text) {
  return String(text).replace(ANY_TAG_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

/* Incremental sentence splitter, bracket-aware. push() returns any newly
   completed sentences; flush() returns the remainder when the stream ends. */
export class SentenceSplitter {
  constructor() { this.buf = ''; }
  push(chunk) { this.buf += chunk; return this._extract(); }
  flush() {
    const out = this._extract();
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) out.push(rest);
    return out;
  }
  _extract() {
    const out = [];
    for (;;) {
      const idx = this._boundary();
      if (idx < 0) break;
      const sent = this.buf.slice(0, idx + 1).trim();
      this.buf = this.buf.slice(idx + 1);
      if (sent) out.push(sent);
    }
    /* safety cap: never let unpunctuated or perpetually-bracketed text grow the
       buffer unbounded — that would OOM and make _boundary() rescans quadratic on
       a hostile/runaway stream. Force-flush oversized runs. */
    while (this.buf.length > 2000) {
      const chunk = this.buf.slice(0, 2000).trim();
      this.buf = this.buf.slice(2000);
      if (chunk) out.push(chunk);
    }
    return out;
  }
  _boundary() {
    const s = this.buf;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (c === '\n') return i;
        if (c === '.' || c === '!' || c === '?' || c === '…') {
          const next = s[i + 1];
          /* need a following space/end so "3.5" or a mid-stream "." waits */
          if (next === undefined) continue;         /* might still be mid-number/stream */
          if (/\s/.test(next) && !(c === '.' && /\d/.test(s[i - 1]) && /\d/.test(s[i + 2] || ''))) {
            /* swallow runs like "?!" or "..." */
            let j = i;
            while (j + 1 < s.length && /[.!?…]/.test(s[j + 1])) j++;
            return j;
          }
        }
      }
    }
    return -1;
  }
}

/* Groups raw sentences into TTS segments: the first sentence flushes alone
   (fastest time-to-voice), later sentences merge until ~minChars so v3 gets
   enough context for prosody and we spend fewer requests. */
export class SegmentGrouper {
  constructor(minChars = 110) { this.minChars = minChars; this.pend = []; this.pendLen = 0; this.emitted = 0; }
  push(sentence) {
    this.pend.push(sentence); this.pendLen += sentence.length;
    if (this.emitted === 0 || this.pendLen >= this.minChars) return [this._take()];
    return [];
  }
  flush() { return this.pend.length ? [this._take()] : []; }
  _take() {
    const text = this.pend.join(' ');
    this.pend = []; this.pendLen = 0; this.emitted++;
    return text;
  }
}
