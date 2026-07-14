/* Local backend: keeps API keys server-side and normalizes providers.
   /api/chat      -> streams NDJSON events: the LLM reply is split into
                     sentence segments, each synthesized with eleven_v3
                     (audio tags = vocal emotion) while later text is still
                     generating. Event types:
                       {type:'seg',   i, caption, mood[], tts}
                       {type:'audio', i, format, audio, marks[]}   (audio may be null)
                       {type:'ctl',   kind:'scene'|'avatar'|'gesture', name}
                       {type:'done',  full, turnId} | {type:'interrupted'} | {type:'error'}
   /api/interrupt -> abort in-flight generation (barge-in / override)
   /api/scenes    -> scene manifest (procedural defaults + public/scenes/)
   /api/avatars   -> every .vrm in public/models/
   /api/fillers   -> pre-synthesized think-gap sounds ("Mmm", "Hm?"), disk-cached

   Interrupt protocol (unchanged): every request carries a monotonic turnId;
   a newer turn aborts all older in-flight LLM and TTS work; /api/interrupt
   {before} aborts explicitly; aborted work answers/streams interrupted.     */
/* override:true — the project .env is the source of truth, even when a stale
   ELEVENLABS_API_KEY (etc.) lingers in the Windows user environment */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { spawn } from 'child_process';
import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { attachEars, summarizeCues } from './ears.js';
import { attachStt, sttEnabled } from './stt.js';
import { MemoryStore, EXTRACT_SYSTEM, extractPrompt, REFLECT_SYSTEM, reflectPrompt } from './memory.js';
import { Aura } from './aura.js';
import { parseSegment, stripAllTags, SentenceSplitter, SegmentGrouper, GESTURES, AFFECTS, AUDIO_TAGS } from './protocol.js';
import { ARCHETYPES, resolveArchetype, pickVoice } from './archetypes.js';
import { buildSystemPrompt } from './system-prompt.js';
import { streamOpenClaw } from './openclaw.js';
import { isGuardEnabled, moderate, DEFLECTION, makeStageDirectionStripper } from './guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(cors());
app.use(express.json({ limit: '48mb' }));   /* base64 attachments ride inside messages */

const PORT = process.env.PORT || 8686;
const aura = new Aura(process.env);
const memory = new MemoryStore(ROOT);

/* ---------------- asset discovery ---------------- */
const DEFAULT_SCENES = [
  { name: 'violet-dream', label: 'Violet Dream', procedural: { kind: 'aurora', top: '#2a2050', mid: '#161129', bottom: '#0b0817', stars: .55, glow: '#a78bfa' }, lighting: { key: ['#ffffff', .38], rim: ['#7de3d8', .14], amb: ['#bfb8ff', .22] } },
  { name: 'bedroom',      label: 'Bedroom',      procedural: { top: '#31201c', mid: '#1d110d', bottom: '#120a08', stars: 0,   glow: '#ff9d6b' }, lighting: { key: ['#ffd9b0', .34], rim: ['#ff6b9d', .10], amb: ['#c9a68a', .20] } },
  { name: 'sunset-beach', label: 'Sunset Beach', procedural: { top: '#40295e', mid: '#e0705a', bottom: '#2a1a2e', stars: .1,  glow: '#ffd166' }, lighting: { key: ['#ffc98a', .42], rim: ['#ff8e5e', .16], amb: ['#d8a8c8', .22] } },
  { name: 'night-city',   label: 'Night City',   yaw: 180, procedural: { top: '#0a0e1f', mid: '#151d3a', bottom: '#05070f', stars: .85, glow: '#5e8eff' }, lighting: { key: ['#cfe0ff', .34], rim: ['#5e8eff', .18], amb: ['#8fa3d8', .20] } },
  { name: 'cosmos',       label: 'Cosmos',       procedural: { kind: 'nebula', top: '#0a0316', mid: '#170a33', bottom: '#03010a', stars: 1,   glow: '#c17bff' }, lighting: { key: ['#e6d8ff', .34], rim: ['#c17bff', .18], amb: ['#9a86d8', .20] } },
];

function listScenes() {
  const dir = path.join(ROOT, 'public', 'scenes');
  const scenes = DEFAULT_SCENES.map(s => ({ ...s }));
  try {
    for (const f of fs.readdirSync(dir)) {
      const isImg = /\.(jpe?g|png|webp)$/i.test(f), isVid = /\.(mp4|webm)$/i.test(f);
      if (!isImg && !isVid) continue;
      const name = f.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, '-');
      const existing = scenes.find(s => s.name === name);
      const entry = existing || scenes[scenes.push({ name, label: name.replace(/-/g, ' ') }) - 1];
      if (isVid) entry.video = '/scenes/' + f;     /* animated: wins over a same-named image */
      else entry.image = '/scenes/' + f;
    }
  } catch (e) { /* no scenes dir: procedural only */ }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'scenes.json'), 'utf8'));
    for (const m of manifest) {
      const i = scenes.findIndex(s => s.name === m.name);
      if (i > -1) scenes[i] = { ...scenes[i], ...m };
      else scenes.push(m);
    }
  } catch (e) { /* no manifest: fine */ }
  return scenes;
}

function listAvatars() {
  try {
    return fs.readdirSync(path.join(ROOT, 'public', 'models'))
      .filter(f => /\.vrm$/i.test(f))
      .map(f => ({ name: f.replace(/\.vrm$/i, '').toLowerCase().replace(/\s+/g, '-'), url: '/models/' + f }));
  } catch (e) { return []; }
}

/* ---------------- system prompt ---------------- */
function buildSystem(archetypeId, userName) {
  return buildSystemPrompt({
    archetype: resolveArchetype(archetypeId),
    userName,
    sceneNames: listScenes().map(s => s.name),
    memoryCore: memory.renderCore(),
    now: new Date().toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }),
    audioTags: AUDIO_TAGS,
    gestures: GESTURES,
    affects: AFFECTS,
  });
}

/* ---------------- interrupt registry ---------------- */
const inflight = new Map();   /* turnId -> Set<AbortController> */
let latestTurn = 0;

function register(turnId) {
  const ac = new AbortController();
  if (!inflight.has(turnId)) inflight.set(turnId, new Set());
  inflight.get(turnId).add(ac);
  return ac;
}
function release(turnId, ac) {
  const set = inflight.get(turnId);
  if (set) { set.delete(ac); if (!set.size) inflight.delete(turnId); }
}
function abortTurns(before = Infinity) {
  const aborted = [];
  for (const [id, set] of [...inflight.entries()]) {
    if (id <= before) {
      set.forEach(ac => ac.abort());
      aborted.push(id);
      inflight.delete(id);
    }
  }
  return aborted;
}

app.post('/api/interrupt', (req, res) => {
  const before = Number(req.body && req.body.before);
  res.json({ ok: true, aborted: abortTurns(Number.isFinite(before) ? before : Infinity) });
});

/* ---------------- /api/aura ---------------- */
app.post('/api/aura', (req, res) => {
  const state = String((req.body && req.body.state) || 'idle');
  const emotion = String((req.body && req.body.emotion) || 'neutral');
  aura.update(state, emotion);
  res.json({ ok: true, provider: (process.env.AURA_PROVIDER || 'off').toLowerCase() });
});

/* ---------------- attachments ----------------
   Client messages may carry attachments:
     {kind:'image'|'pdf'|'text', name, mime?, data?(base64), text?}
   Media is expensive in context, so only the LAST user message keeps its
   binary payloads; older ones degrade to a text marker. Text files inline
   everywhere. Providers that can't take a media kind get a spoken-friendly
   marker instead so she can still respond about it. */
function inlineTextAtts(content, atts) {
  let out = content;
  for (const a of atts || []) {
    if (a.kind === 'text' && a.text) out += '\n\n[file: ' + (a.name || 'file.txt') + ']\n' + String(a.text).slice(0, 20000);
  }
  return out;
}

function normalizeAttachments(messages, provider) {
  const lastUser = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
    return -1;
  })();
  return messages.map((m, i) => {
    const atts = m.attachments || [];
    const media = atts.filter(a => a.kind === 'image' || a.kind === 'pdf');
    let text = inlineTextAtts(String(m.content || ''), atts);
    if (!media.length) return { role: m.role, content: text };

    if (i !== lastUser) {
      /* history: media collapses to a marker */
      text += '\n[attachments shared earlier: ' + media.map(a => a.name || a.kind).join(', ') + ']';
      return { role: m.role, content: text };
    }
    if (provider === 'anthropic') {
      const blocks = [];
      for (const a of media) {
        if (a.kind === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime || 'image/jpeg', data: a.data } });
        else blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
      }
      blocks.push({ type: 'text', text: text || 'See the attached files.' });
      return { role: m.role, content: blocks };
    }
    if (provider === 'ollama') {
      const images = media.filter(a => a.kind === 'image').map(a => a.data);
      const pdfs = media.filter(a => a.kind === 'pdf');
      if (pdfs.length) text += '\n[PDF attached (' + pdfs.map(a => a.name).join(', ') + ') — this provider cannot read PDFs; ask Ori to describe it or switch LLM_PROVIDER=anthropic]';
      const out = { role: m.role, content: text };
      if (images.length) out.images = images;
      return out;
    }
    /* CLI providers: text only */
    text += '\n[' + media.length + ' attachment(s) shared: ' + media.map(a => a.name || a.kind).join(', ') + ' — this provider cannot see media, respond from context]';
    return { role: m.role, content: text };
  });
}

/* ---------------- subscription-auth CLI providers ----------------
   No API key: these spawn locally installed CLIs that carry the user's own
   subscription login (claude -p = Claude sub, codex exec = ChatGPT sub,
   gemini = Google account). Single-shot: history is rendered into the prompt. */
function renderTranscript(msgs) {
  const turns = msgs.map(m =>
    (m.role === 'user' ? 'Ori: ' : 'Lyra: ') +
    (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n');
  return 'Conversation so far:\n\n' + turns + '\n\nWrite Lyra\'s next reply only — no name prefix, no quotes.';
}

function runCli(cmd, args, promptText, ac, onLine, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    let err = '', buf = '';
    const onAbort = () => { try { child.kill(); } catch (e) {} };
    ac.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => {
      const s = d.toString('utf8');
      if (onChunk) onChunk(s);
      if (onLine) {
        buf += s;
        let nl;
        while ((nl = buf.indexOf('\n')) > -1) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
    });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      ac.signal.removeEventListener('abort', onAbort);
      if (onLine && buf.trim()) onLine(buf);
      if (ac.signal.aborted) return reject(new Error('interrupted'));
      if (code !== 0) return reject(new Error(cmd + ' exited ' + code + ': ' + err.slice(0, 300)));
      resolve();
    });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

async function streamClaudeCode(msgs, ac, onDelta, system) {
  const prompt = (system || buildSystem()) + '\n\n---\n\n' + renderTranscript(msgs);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', '1'];
  if (process.env.CLAUDE_CLI_MODEL) args.push('--model', process.env.CLAUDE_CLI_MODEL);
  let gotDelta = false, full = '';
  await runCli('claude', args, prompt, ac, line => {
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta'
        && j.event.delta && j.event.delta.type === 'text_delta') {
      gotDelta = true;
      onDelta(j.event.delta.text);
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      full = j.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
  });
  if (!gotDelta && full) onDelta(full);
}

async function streamCodex(msgs, ac, onDelta, system) {
  const prompt = (system || buildSystem()) + '\n\n---\n\n' + renderTranscript(msgs);
  let got = false;
  await runCli('codex', ['exec', '--json', '-'], prompt, ac, line => {
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    const item = j.item || j.msg || j;
    const text = item && (item.text || item.last_agent_message);
    const type = item && (item.item_type || item.type);
    if (text && /agent_message|assistant/.test(String(type))) { got = true; onDelta(text); }
  });
  if (!got) throw new Error('codex produced no reply (is it installed and logged in?)');
}

async function streamGeminiCli(msgs, ac, onDelta, system) {
  const prompt = (system || buildSystem()) + '\n\n---\n\n' + renderTranscript(msgs);
  await runCli('gemini', [], prompt, ac, null, chunk => {
    /* plain text stream; drop known startup noise lines */
    const clean = chunk.split('\n').filter(l => !/^(Loaded cached|Data collection|MCP STDERR|\[.*\])/.test(l.trim())).join('\n');
    if (clean) onDelta(clean);
  });
}

/* ---------------- LLM streaming ---------------- */
async function streamOllama(msgs, ac, onDelta, system) {
  const r = await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: ac.signal,
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.1',
      stream: true,
      messages: [{ role: 'system', content: system || buildSystem() }, ...msgs],
    }),
  });
  if (!r.ok) throw new Error('ollama ' + r.status);
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const d = j.message && j.message.content;
        if (d) onDelta(d);
      } catch (e) { /* partial line noise */ }
    }
  }
}

async function streamAnthropic(msgs, ac, onDelta, system) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing in .env');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: ac.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 2000,
      stream: true,
      system: system || buildSystem(),
      messages: msgs,
    }),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') onDelta(j.delta.text);
      } catch (e) { /* keep-alives etc. */ }
    }
  }
}

/* ---------------- TTS ---------------- */
let elevenTs = null;   /* does the account/model support /with-timestamps? learned at runtime */

function marksFromAlignment(alignment) {
  /* build word marks, skipping [audio tag] characters so captions/visemes
     never fire on tags that v3 renders as sound rather than speech */
  const marks = [];
  const chars = alignment ? alignment.characters : [];
  const starts = alignment ? alignment.character_start_times_seconds : [];
  let word = '', t0 = 0, depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '[') { depth++; if (word) { marks.push({ word, t: t0 }); word = ''; } continue; }
    if (c === ']') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (/\s/.test(c)) { if (word) { marks.push({ word, t: t0 }); word = ''; } }
    else { if (!word) t0 = starts[i]; word += c; }
  }
  if (word) marks.push({ word, t: t0 });
  /* glue punctuation-only "words" (left behind by removed tags) to the
     previous mark so caption tokens and marks stay index-aligned */
  for (let i = marks.length - 1; i > 0; i--) {
    if (!/[\p{L}\p{N}]/u.test(marks[i].word)) {
      marks[i - 1].word += marks[i].word;
      marks.splice(i, 1);
    }
  }
  return marks;
}

async function synthEleven(text, voiceId, signal) {
  const vid = voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!process.env.ELEVENLABS_API_KEY || !vid)
    throw new Error('ElevenLabs key/voice missing in .env');
  const model = process.env.ELEVENLABS_MODEL || 'eleven_v3';
  const base = 'https://api.elevenlabs.io/v1/text-to-speech/' + vid;
  const headers = { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY };
  const body = JSON.stringify({ text, model_id: model });

  if (elevenTs !== false) {
    const r = await fetch(base + '/with-timestamps?output_format=mp3_44100_128', { method: 'POST', signal, headers, body });
    if (r.ok) {
      elevenTs = true;
      const data = await r.json();
      return { format: 'mp3', audio: data.audio_base64, marks: marksFromAlignment(data.alignment) };
    }
    if (![400, 404, 405, 422].includes(r.status))
      throw new Error('elevenlabs ' + r.status + ' ' + (await r.text()).slice(0, 180));
    elevenTs = false;   /* model has no timestamp endpoint: fall through once, remember */
  }
  const r = await fetch(base + '?output_format=mp3_44100_128', { method: 'POST', signal, headers, body });
  if (!r.ok) throw new Error('elevenlabs ' + r.status + ' ' + (await r.text()).slice(0, 180));
  return { format: 'mp3', audio: Buffer.from(await r.arrayBuffer()).toString('base64'), marks: [] };
}

async function synthEdge(text, edgeVoice, signal) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(edgeVoice || process.env.EDGE_VOICE || 'en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const result = await tts.toStream(stripAllTags(text));
  const stream = result.audioStream || result;
  signal.addEventListener('abort', () => { try { stream.destroy(new Error('interrupted')); } catch (e) {} });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', d => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  if (signal.aborted) throw new Error('interrupted');
  return { format: 'mp3', audio: Buffer.concat(chunks).toString('base64'), marks: [] };
}

async function synthSegment(text, archetype, signal) {
  const engine = (process.env.TTS_PROVIDER || 'edge').toLowerCase();
  if (engine === 'elevenlabs')
    return synthEleven(text, pickVoice(archetype, 'elevenlabs', { elevenlabs: process.env.ELEVENLABS_VOICE_ID }), signal);
  if (engine === 'edge')
    return synthEdge(text, pickVoice(archetype, 'edge', { edge: process.env.EDGE_VOICE }), signal);
  return null;   /* browser: client speaks via speechSynthesis */
}

/* ---------------- memory extraction (best-effort, off the hot path) ---------------- */
let sinceExtract = 0;

async function runProvider(provider, m, ac, onDelta, system) {
  if (provider === 'ollama') return streamOllama(m, ac, onDelta, system);
  if (provider === 'claude-code') return streamClaudeCode(m, ac, onDelta, system);
  if (provider === 'codex') return streamCodex(m, ac, onDelta, system);
  if (provider === 'gemini-cli') return streamGeminiCli(m, ac, onDelta, system);
  if (provider === 'openclaw') return streamOpenClaw(m, ac, onDelta, {});
  return streamAnthropic(m, ac, onDelta, system);
}

async function extractMemory(provider, msgs, reply) {
  const stamp = '[time: ' + new Date().toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }) + ']';
  const transcript = stamp + '\n' + msgs.slice(-6).map(m =>
    (m.role === 'user' ? 'User: ' : 'Her: ') +
    (typeof m.content === 'string' ? m.content : '[media message]')).join('\n')
    + '\nHer: ' + stripAllTags(reply).slice(0, 2000);
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 90000);
  let out = '';
  try {
    await runProvider(provider, [{ role: 'user', content: extractPrompt(memory.known(), transcript) }],
      ac, d => { out += d; }, EXTRACT_SYSTEM);
    const n = memory.addFacts(out.split('\n'));
    if (n) console.log('[memory] +' + n + ' entrie(s), ' + memory.facts.length + ' total');
    /* every few extractions, the inner monologue re-reads everything */
    memory.meta.extracts = (memory.meta.extracts || 0) + 1;
    if (memory.meta.extracts % 4 === 0 && memory.facts.length >= 8) reflectMemory(provider);
  } catch (e) { /* memory is a bonus, never an error */ }
  finally { clearTimeout(kill); }
}

async function reflectMemory(provider) {
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 120000);
  let out = '';
  try {
    await runProvider(provider, [{ role: 'user', content: reflectPrompt(memory.all()) }],
      ac, d => { out += d; }, REFLECT_SYSTEM);
    const n = memory.addFacts(out.split('\n'), 'pattern');
    if (n) console.log('[memory] reflection +' + n + ' insight(s)');
  } catch (e) { /* reflection is a luxury */ }
  finally { clearTimeout(kill); }
}

app.get('/api/memory', (req, res) => res.json({ facts: memory.facts }));
app.delete('/api/memory', (req, res) => { memory.clear(); res.json({ ok: true }); });

/* ---------------- /api/vision ----------------
   One webcam frame in -> compact emotional observation out. The client polls
   this every few seconds while the camera is on; the note rides into the next
   chat turn as [seen through the camera: ...] and expression/proximity drive
   instant subconscious reactions. Frames are analyzed and discarded. */
const VISION_SYSTEM = 'You are the visual cortex of a companion AI watching her human through his webcam. ' +
  'Output ONLY minified JSON: {"note":"one short sentence - expression, posture, gesture, anything emotionally relevant you see","expression":"happy|sad|neutral|tired|surprised|focused","proximity":"close|normal|far"}';

app.post('/api/vision', async (req, res) => {
  const img = String((req.body && req.body.image) || '');
  if (!img) return res.status(400).json({ error: 'no image' });
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (provider !== 'ollama' && provider !== 'anthropic')
    return res.json({ error: 'provider ' + provider + ' cannot see images' });

  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 25000);
  let out = '';
  try {
    const msg = provider === 'ollama'
      ? { role: 'user', content: 'What do you see right now?', images: [img] }
      : {
          role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
            { type: 'text', text: 'What do you see right now?' },
          ],
        };
    await runProvider(provider, [msg], ac, d => { out += d; }, VISION_SYSTEM);
    const a = out.indexOf('{'), b = out.lastIndexOf('}');
    const j = JSON.parse(out.slice(a, b + 1));
    res.json({
      note: String(j.note || '').slice(0, 200),
      expression: String(j.expression || 'neutral'),
      proximity: String(j.proximity || 'normal'),
    });
  } catch (e) {
    if (!res.headersSent) res.json({ error: 'vision failed: ' + e.message.slice(0, 120) });
  } finally { clearTimeout(kill); }
});

/* ---------------- /api/chat (streaming) ---------------- */
function makeQueue(n) {
  let active = 0; const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
}

app.post('/api/chat', async (req, res) => {
  const messages = (req.body && req.body.messages) || [];
  const turnId = Number(req.body && req.body.turnId) || (latestTurn + 1);
  if (turnId > latestTurn) latestTurn = turnId;
  abortTurns(turnId - 1);                 /* a newer turn overrides older work */
  const ac = register(turnId);
  const provider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const archetypeId = String((req.body && req.body.archetype) || 'lyra');
  const userName = String((req.body && req.body.userName) || '').slice(0, 40).trim();
  const archetype = resolveArchetype(archetypeId);
  const ttsOn = (process.env.TTS_PROVIDER || 'edge').toLowerCase() !== 'browser';
  const guardOn = isGuardEnabled();

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();
  const send = o => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };

  /* attach paralinguistic + visual + time context to the last user message */
  const timeNote = '[now: ' + new Date().toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }) + ']';
  const visionNote = req.body && req.body.context ? String(req.body.context).slice(0, 300) : '';
  const note = [summarizeCues(), visionNote, timeNote].filter(Boolean).join(' ');
  let msgs = messages;
  let lastUserText = '';
  if (messages.length) {
    msgs = messages.slice();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUserText = String(msgs[i].content || '');
        msgs[i] = { ...msgs[i], content: msgs[i].content + '\n' + note };
        break;
      }
    }
  }

  /* OpenClaw owns the brain, so the per-character persona never reaches it via a
     system prompt — inject it as a roleplay framing on the turn so the five
     characters actually differ (best-effort; competes with the agent's own config). */
  if (provider === 'openclaw' && msgs.length) {
    const persona = String(archetype.persona || '').replace(/\{userName\}/g, userName || 'them');
    const boundary = guardOn ? ' Keep it SWEET and warm, never steamy: affection, gentle playful teasing, genuine care and charm — but no sexual tension, no come-ons, no innuendo, and nothing graphic or explicit. Tender and charming, not sultry or seductive. Refuse anything harmful.' : '';
    const framing = '[Reply entirely in character as ' + archetype.name + ' — "' + archetype.tagline + '". ' + persona + boundary
      + ' Write ONLY her spoken words — no stage directions, no parentheses, no asterisks, no narration; her body and expressions are performed for you.]';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { msgs[i] = { ...msgs[i], content: framing + '\n\n' + msgs[i].content }; break; }
    }
  }

  /* semantic recall: old memories related to right now ride into the prompt */
  let system = buildSystem(archetypeId, userName);
  try {
    const rel = await memory.retrieve(lastUserText);
    if (rel.length) system += '\n\n' + memory.renderRelevant(rel);
  } catch (e) { /* recall is best-effort */ }

  const splitter = new SentenceSplitter();
  const grouper = new SegmentGrouper();
  const queue = makeQueue(2);
  const ttsJobs = [];
  let segIdx = 0, full = '';
  let guardTripped = false;                      /* once a reply crosses the line, she redirects and the turn ends */
  const stripStage = makeStageDirectionStripper();   /* OpenClaw narrates in parens across segments */

  const speakParsed = p => {
    for (const ev of p.events) {
      if (ev.kind === 'remember') memory.addFacts([ev.name], 'moment');
      send({ type: 'ctl', ...ev });
    }
    if (!p.caption) return;                       /* pure-directive segment */
    const i = segIdx++;
    send({ type: 'seg', i, caption: p.caption, mood: p.mood, tts: ttsOn });
    if (!ttsOn) return;
    ttsJobs.push(queue(async () => {
      if (ac.signal.aborted) return;
      try {
        const a = await synthSegment(p.ttsText, archetype, ac.signal);
        send({ type: 'audio', i, ...(a || { audio: null }) });
      } catch (e) {
        if (!ac.signal.aborted) send({ type: 'audio', i, audio: null, error: e.message });
      }
    }));
  };

  const emitSegment = text => {
    if (guardTripped) return;                     /* suppress the remainder of a blocked reply */
    if (provider === 'openclaw') text = stripStage(text);   /* agent narrates in parens; don't voice it */
    const p = parseSegment(text);
    if (guardOn && p.caption && moderate(p.caption).blocked) {
      guardTripped = true;
      speakParsed(parseSegment(DEFLECTION));      /* Lyra holds the line in-character */
      return;
    }
    speakParsed(p);
  };
  const onDelta = d => {
    full += d;
    for (const s of splitter.push(d)) for (const g of grouper.push(s)) emitSegment(g);
  };

  msgs = normalizeAttachments(msgs, provider);

  try {
    await runProvider(provider, msgs, ac, onDelta, system);
    for (const s of splitter.flush()) for (const g of grouper.push(s)) emitSegment(g);
    for (const g of grouper.flush()) emitSegment(g);
    await Promise.allSettled(ttsJobs);
    if (ac.signal.aborted) send({ type: 'interrupted', turnId });
    else {
      send({ type: 'done', full, turnId });
      /* every couple of exchanges, quietly mine the conversation for memories */
      if (full && ++sinceExtract >= 2) { sinceExtract = 0; extractMemory(provider, msgs, full); }
    }
  } catch (e) {
    if (ac.signal.aborted) send({ type: 'interrupted', turnId });
    else send({ type: 'error', message: e.message, turnId });
  } finally {
    release(turnId, ac);
    res.end();
  }
});

/* ---------------- /api/fillers ---------------- */
/* tiny pre-synthesized think-gap sounds, cached on disk so they cost once */
const FILLER_TEXTS = ['Mmm.', 'Hmm...', 'Mm-hm.', '[softly] Hm?'];
let fillersPromise = null;

app.get('/api/fillers', async (req, res) => {
  const provider = (process.env.TTS_PROVIDER || 'edge').toLowerCase();
  if (provider !== 'elevenlabs') return res.json({ clips: [] });
  const model = process.env.ELEVENLABS_MODEL || 'eleven_v3';
  const cacheFile = path.join(ROOT, 'server', '.cache',
    'fillers-' + (process.env.ELEVENLABS_VOICE_ID || 'v') + '-' + model + '.json');
  try {
    return res.json(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
  } catch (e) { /* not cached yet */ }
  try {
    if (!fillersPromise) {
      fillersPromise = (async () => {
        const clips = [];
        for (const t of FILLER_TEXTS) {
          try {
            const a = await synthEleven(t, process.env.ELEVENLABS_VOICE_ID, new AbortController().signal);
            if (a) clips.push({ format: a.format, audio: a.audio });
          } catch (e) { /* skip a failed clip */ }
        }
        const payload = { clips };
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(payload));
        return payload;
      })();
      fillersPromise.catch(() => { fillersPromise = null; });
    }
    res.json(await fillersPromise);
  } catch (e) {
    res.json({ clips: [] });
  }
});

/* ---------------- manifests + health ---------------- */
app.get('/api/scenes', (req, res) => res.json({ scenes: listScenes() }));
app.get('/api/avatars', (req, res) => res.json({ avatars: listAvatars() }));

/* Public archetype list for the character picker — persona/voice/greeting
   stay server-side; the client only needs display + defaults. */
app.get('/api/archetypes', (req, res) => {
  res.json({ archetypes: ARCHETYPES.map(a => ({
    id: a.id, name: a.name, tagline: a.tagline, traits: a.traits, portrait: a.portrait, scene: a.scene,
  })) });
});

/* Speak a character's fixed greeting through the segment/TTS pipeline, so the
   client plays it exactly like a normal reply (no LLM call). */
app.post('/api/greet', async (req, res) => {
  const archetype = resolveArchetype(String((req.body && req.body.archetype) || 'lyra'));
  const userName = String((req.body && req.body.userName) || '').slice(0, 40).trim();
  const ttsOn = (process.env.TTS_PROVIDER || 'edge').toLowerCase() !== 'browser';
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  if (res.flushHeaders) res.flushHeaders();
  const send = o => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };
  const ac = new AbortController();
  let finished = false;                       /* abort only on a real premature disconnect,
     not when the request body is merely fully read (Node fires req 'close' then) */
  res.on('close', () => { if (!finished) ac.abort(); });
  try {
    const text = String(archetype.greeting || '').replace(/\{userName\}/g, userName || 'you');
    const p = parseSegment(text);
    if (p.caption) {
      send({ type: 'seg', i: 0, caption: p.caption, mood: p.mood, tts: ttsOn });
      if (ttsOn) {
        try {
          const a = await synthSegment(p.ttsText, archetype, ac.signal);
          send({ type: 'audio', i: 0, ...(a || { audio: null }) });
        } catch (e) {
          if (!ac.signal.aborted) send({ type: 'audio', i: 0, audio: null, error: e.message });
        }
      }
    }
    send({ type: 'done', full: text, turnId: 0 });
  } catch (e) {
    send({ type: 'error', message: e.message, turnId: 0 });
  } finally {
    finished = true;
    res.end();
  }
});
app.get('/api/animations', (req, res) => {
  try {
    res.json({ files: fs.readdirSync(path.join(ROOT, 'public', 'animations')).filter(f => /\.fbx$/i.test(f)) });
  } catch (e) { res.json({ files: [] }); }
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  llm: process.env.LLM_PROVIDER || 'anthropic',
  tts: process.env.TTS_PROVIDER || 'edge',
  ttsModel: process.env.ELEVENLABS_MODEL || 'eleven_v3',
  stt: sttEnabled() ? 'deepgram' : 'webspeech',
  aura: process.env.AURA_PROVIDER || 'off',
  latestTurn,
  inflightTurns: [...inflight.keys()],
}));

const server = http.createServer(app);
attachEars(server);
attachStt(server);
server.listen(PORT, () => console.log('[lyra] backend on http://localhost:' + PORT +
  ' | llm=' + (process.env.LLM_PROVIDER || 'anthropic') +
  ' tts=' + (process.env.TTS_PROVIDER || 'edge') + '/' + (process.env.ELEVENLABS_MODEL || 'eleven_v3') +
  ' aura=' + (process.env.AURA_PROVIDER || 'off') +
  ' | ears WebSocket on /ears'));
