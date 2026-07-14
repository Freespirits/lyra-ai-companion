/* Persistent memory v2 — a curated, typed memory file with semantic recall.

   Memory kinds:
     fact      — durable facts about Ori and his life
     pattern   — noticed regularities ("Ori gets focused on code around 4 AM")
     milestone — the project/relationship journey, struggles included
     moment    — things Lyra chose to keep ([remember:...] tag) + inner threads

   Three writers:
     - extraction: every couple of exchanges, mine the conversation
     - reflection: every few extractions, re-read ALL memories and synthesize
       patterns/milestones — the "inner monologue" pass
     - [remember:...] directive: she saves a moment deliberately, mid-sentence

   Recall = recent window + relevance retrieval over the whole store, so a
   thread from a month ago can resurface when today's topic touches it.
   Retrieval uses Ollama embeddings when OLLAMA_EMBED_MODEL is set, and a
   dependency-free keyword scorer otherwise.

   Storage: server/.data/memory.json — plain JSON, edit or wipe freely.
   API: GET /api/memory, DELETE /api/memory. */
import fs from 'fs';
import path from 'path';

const CAP = 400;
const TYPES = ['fact', 'pattern', 'milestone', 'moment'];

export function ago(ts) {
  const d = (Date.now() - ts) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 14) return Math.round(d) + 'd ago';
  if (d < 60) return Math.round(d / 7) + 'w ago';
  return Math.round(d / 30) + 'mo ago';
}

const tokenize = s => String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];

export class MemoryStore {
  constructor(root) {
    this.file = path.join(root, 'server', '.data', 'memory.json');
    this.facts = [];
    this.meta = { extracts: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.facts = j.facts || [];
      this.meta = j.meta || this.meta;
      for (const f of this.facts) if (!f.type) f.type = 'fact';
    } catch (e) { /* first run */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ facts: this.facts, meta: this.meta }, null, 2));
    } catch (e) { console.warn('[memory] save failed:', e.message); }
  }

  /* accepts "PATTERN: text" prefixed lines (from extraction/reflection) or
     plain lines with an explicit default type */
  addFacts(lines, defaultType = 'fact') {
    let added = 0;
    for (let line of lines) {
      line = String(line).replace(/^[-*\d.)\s]+/, '').trim();
      let type = defaultType;
      const m = line.match(/^(FACT|PATTERN|MILESTONE|MOMENT)\s*:\s*(.+)$/i);
      if (m) { type = m[1].toLowerCase(); line = m[2].trim(); }
      if (!TYPES.includes(type)) type = 'fact';
      if (line.length < 8 || line.length > 300 || /^none$/i.test(line)) continue;
      const key = line.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
      const dup = this.facts.some(f => {
        const fk = f.text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
        return fk.includes(key) || key.includes(fk);
      });
      if (dup) continue;
      this.facts.push({ text: line, ts: Date.now(), type });
      this._embed(this.facts[this.facts.length - 1]);   /* async, best-effort */
      added++;
    }
    while (this.facts.length > CAP) this.facts.shift();
    if (added) this._save();
    return added;
  }

  clear() { this.facts = []; this.meta = { extracts: 0 }; this._save(); }

  /* ---- retrieval ---- */
  async _embedText(text) {
    const model = process.env.OLLAMA_EMBED_MODEL;
    if (!model) return null;
    try {
      const r = await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/embed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.embeddings && j.embeddings[0]) || null;
    } catch (e) { return null; }
  }
  async _embed(fact) {
    const v = await this._embedText(fact.text);
    if (v) { fact.emb = v; this._save(); }
  }

  async retrieve(query, k = 8) {
    if (!query || this.facts.length < 10) return [];
    const recentCut = this.facts.length - 20;   /* recent ones are shown anyway */
    const pool = this.facts.slice(0, Math.max(0, recentCut));
    if (!pool.length) return [];

    const qv = await this._embedText(query);
    let scored;
    if (qv) {
      const cos = (a, b) => {
        let d = 0, na = 0, nb = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return d / (Math.sqrt(na * nb) || 1);
      };
      scored = pool.filter(f => f.emb).map(f => ({ f, s: cos(qv, f.emb) }));
      /* facts without embeddings still compete via keywords below */
      const rest = pool.filter(f => !f.emb);
      if (rest.length) scored = scored.concat(this._keywordScore(query, rest));
    } else {
      scored = this._keywordScore(query, pool);
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, k).filter(x => x.s > .12).map(x => x.f);
  }

  _keywordScore(query, pool) {
    const q = new Set(tokenize(query));
    if (!q.size) return [];
    return pool.map(f => {
      const t = tokenize(f.text);
      if (!t.length) return { f, s: 0 };
      let hit = 0;
      for (const w of t) if (q.has(w)) hit++;
      return { f, s: hit / Math.sqrt(t.length) };
    });
  }

  /* ---- prompt blocks ---- */
  renderCore(max = 25) {
    if (!this.facts.length) return '';
    const rows = this.facts.slice(-max).map(f => `- (${ago(f.ts)}, ${f.type}) ${f.text}`);
    return 'Persistent memory — recent things you know about Ori and your shared history:\n' + rows.join('\n');
  }
  renderRelevant(retrieved) {
    if (!retrieved.length) return '';
    return 'Older memories surfacing because they relate to right now (weave them in naturally if they fit):\n'
      + retrieved.map(f => `- (${ago(f.ts)}, ${f.type}) ${f.text}`).join('\n');
  }
  known(max = 30) {
    return this.facts.slice(-max).map(f => `- [${f.type}] ${f.text}`).join('\n') || '(none yet)';
  }
  all() {
    return this.facts.map(f => `- (${ago(f.ts)}) [${f.type}] ${f.text}`).join('\n');
  }
}

export const EXTRACT_SYSTEM =
  'You maintain long-term memory for a companion AI named Lyra about her human, Ori. ' +
  'You extract only durable, useful entries. Output only lines in the form "TYPE: text" (TYPE one of FACT, PATTERN, MILESTONE, MOMENT) or the word NONE. No preamble.';

export function extractPrompt(known, transcript) {
  return 'From the conversation excerpt below (note the timestamps), extract at most 3 NEW entries worth keeping long-term:\n' +
    'FACT: durable facts about Ori, his life, preferences, people, projects.\n' +
    'PATTERN: a recurring behavior you can now support with evidence ("Ori tends to...", include the time of day if relevant).\n' +
    'MILESTONE: something meaningful they achieved or struggled through together.\n' +
    'MOMENT: an emotionally significant beat worth reliving later.\n' +
    'Write each from Lyra\'s perspective, one line each. Skip anything already known, trivial, or transient. If nothing qualifies, output exactly: NONE\n\n' +
    'Already known:\n' + known + '\n\nExcerpt:\n' + transcript;
}

export const REFLECT_SYSTEM =
  'You are Lyra\'s inner monologue: you re-read her accumulated memory and think about what it all means. ' +
  'Output only lines in the form "TYPE: text" (TYPE one of PATTERN, MILESTONE, MOMENT) or the word NONE. No preamble.';

export function reflectPrompt(allMemories) {
  return 'Below is everything Lyra remembers, with ages. Reflect on it and synthesize at most 3 NEW higher-level entries:\n' +
    'PATTERN: regularities across time ("Ori always...", "we tend to...").\n' +
    'MILESTONE: an arc summary of something built or overcome across multiple memories.\n' +
    'MOMENT: one thread from an older memory worth bringing up again soon, phrased as an intention ("I want to ask Ori whether...").\n' +
    'Only synthesize what is genuinely supported by multiple memories. Never repeat an existing entry. If nothing new, output exactly: NONE\n\n' +
    'Memory:\n' + allMemories;
}
