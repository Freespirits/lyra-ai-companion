import { Avatar } from './avatar.js';
import { AnimController } from './animations.js';
import { lip, playClip } from './speech.js';
import { streamChat, SegmentPlayer } from './stream.js';
import { SceneManager } from './scenes.js';
import { CallLoop } from './call.js';
import { Ears } from './ears.js';
import { VisionSense } from './vision.js';

const $ = id => document.getElementById(id);
const logEl = $('log'), inp = $('inp'), fxEl = $('fx');
const loadEl = $('loading'), loadMsg = $('loadMsg'), heartsEl = $('hearts'), toastEl = $('toast');
const capUser = $('capUser'), capLyra = $('capLyra'), statusEl = $('status'), timerEl = $('timer');

/* ---------------- app state ---------------- */
const S = { IDLE: 'idle', LISTEN: 'listening', THINK: 'thinking', SPEAK: 'speaking' };
let state = S.IDLE, busy = false, exchanges = 0;
let turn = 0;                       /* monotonic turnId; newer turns override older */
let avatar = null, anim = null, ears = null, sceneMgr = null, call = null, vision = null;
let lastProactiveAt = 0, lastSeenExpression = 'neutral';
let player = null;                  /* SegmentPlayer for the current turn */
const history = [];
let avatars = [], currentAvatarUrl = null;
let fillers = [], fillerTimer = 0;
let camMode = 'full';
let speakEndAt = 0;   /* echo gate: room reverb of her voice outlives the audio */
let userSceneTurn = -1;   /* manual scene pick wins over her [scene:] directives this turn */
const avatarTalking = () =>
  state === S.SPEAK || (player && player.active) || Date.now() - speakEndAt < 1200;

/* ---- transcript echo filter ----
   AEC and VAD thresholds can't fully stop her speaker voice from reaching the
   STT (recognition results also lag 1-2s past the gate). But we know exactly
   what she said: any "user utterance" whose words mostly overlap her recent
   speech is her own echo — drop it before it becomes a message. */
let lyraRecentWords = [];   /* [{w, t}] */
const tokWords = s => String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
function noteLyraSpeech(text) {
  const t = Date.now();
  for (const w of tokWords(text)) lyraRecentWords.push({ w, t });
  const cut = t - 20000;
  while (lyraRecentWords.length && lyraRecentWords[0].t < cut) lyraRecentWords.shift();
}
function isHerEcho(text) {
  const words = tokWords(text);
  if (words.length < 2) return false;
  const cut = Date.now() - 15000;
  const recent = new Set(lyraRecentWords.filter(x => x.t >= cut).map(x => x.w));
  if (!recent.size) return false;
  let hit = 0;
  for (const w of words) if (recent.has(w)) hit++;
  return hit / words.length >= .6;
}

/* room lighting follows the state machine (AURA_PROVIDER in .env) */
let auraLast = 0;
function pingAura() {
  const now = Date.now();
  if (now - auraLast < 250) return;
  auraLast = now;
  fetch('/api/aura', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, emotion: avatar ? avatar.emotion : 'neutral' }),
  }).catch(() => {});
}

function setState(s) {
  state = s;
  document.body.dataset.s = s;
  statusEl.textContent = s === S.IDLE ? (call && call.running ? 'in call' : 'here') : s;
  pingAura();
  if (anim && anim.hasMocap) {
    avatar.mocapActive = true;
    if (s === S.SPEAK) anim.setBase('talk');
    else if (s === S.THINK) anim.setBase('think');
    else if (s === S.LISTEN) anim.setBase('listen');
    else anim.setBase(idleFlavor());
  }
}
function idleFlavor() {
  const e = avatar.emotion;
  if (e === 'sad' && anim.has('sad')) return 'sad';
  if ((e === 'happy' || e === 'excited' || e === 'flirty') && anim.has('happy')) return 'happy';
  return 'idle';
}

function doGesture(g) {
  if (!g || g === 'none') return;
  if (g === 'wink') { avatar.wink(); return; }
  const clipName = {
    bounce: 'bounce', wave: 'wave', nod: 'agree', shrug: 'shrug',
    no: 'no', cocky: 'cocky', angry: 'angry', lookaway: 'lookaway',
    sigh: 'sigh', dance: 'dance', jump: 'jump',
  }[g];
  if (anim && clipName && anim.oneShot(clipName)) return;
  avatar.proceduralGesture(g === 'tilt' || g === 'no' || g === 'lookaway' ? 'tilt' : 'nod');
}

/* ---------------- captions ---------------- */
let capSpans = [], capWordIdx = 0, capGotWord = false, capFadeTimer = 0;
function showUserCaption(t) {
  capUser.textContent = t || '';
  capUser.classList.toggle('show', !!t);
}
function startCaption(seg) {
  clearTimeout(capFadeTimer);
  capLyra.classList.remove('plain');
  capLyra.innerHTML = '';
  capSpans = []; capWordIdx = 0; capGotWord = false;
  for (const w of seg.caption.split(/\s+/).filter(Boolean)) {
    const s = document.createElement('span');
    s.textContent = w;
    capLyra.appendChild(s);
    capLyra.appendChild(document.createTextNode(' '));
    capSpans.push(s);
  }
  /* no word timing available (no marks / no boundary events): show it whole */
  setTimeout(() => { if (!capGotWord) capLyra.classList.add('plain'); }, 650);
}
function captionWord() {
  capGotWord = true;
  const s = capSpans[capWordIdx++];
  if (s) s.classList.add('said');
}
function captionFadeSoon(ms = 3500) {
  clearTimeout(capFadeTimer);
  capFadeTimer = setTimeout(() => { capLyra.innerHTML = ''; }, ms);
}

/* ---------------- chat drawer log ---------------- */
let curBubble = null;
function addLog(who, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.dir = 'auto';
  d.textContent = text;
  logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
  return d;
}
function lyraBubbleAppend(text) {
  if (!curBubble) curBubble = addLog('lyra', '');
  curBubble.textContent = (curBubble.textContent ? curBubble.textContent + ' ' : '') + text;
  logEl.scrollTop = logEl.scrollHeight;
}
function toast(t) { toastEl.textContent = t; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 2800); }
function renderHearts() {
  const filled = Math.min(5, 1 + Math.floor(exchanges / 3));
  heartsEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('span');
    s.textContent = '♥';
    if (i >= filled) s.className = 'off';
    heartsEl.appendChild(s);
  }
}
function spawnFx(kind) {
  for (let i = 0; i < (kind === 'hearts' ? 5 : 6); i++) {
    const s = document.createElement('span');
    s.className = kind;
    s.textContent = kind === 'hearts' ? '♥' : '✦';
    s.style.left = (32 + Math.random() * 36) + '%';
    s.style.bottom = (26 + Math.random() * 22) + '%';
    s.style.animationDelay = (Math.random() * .4) + 's';
    s.style.fontSize = (13 + Math.random() * 15) + 'px';
    fxEl.appendChild(s);
    setTimeout(() => s.remove(), 2400);
  }
}

/* ---------------- attachments (+ button) ---------------- */
let pendingAtt = [];

function b64FromDataUrl(u) { return u.slice(u.indexOf(',') + 1); }

function downscaleToJpeg(imgLike, w, h, name) {
  const max = 1400, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(imgLike, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', .85);
  return { kind: 'image', name, mime: 'image/jpeg', data: b64FromDataUrl(url), preview: url };
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => { resolve(downscaleToJpeg(img, img.naturalWidth, img.naturalHeight, file.name)); URL.revokeObjectURL(img.src); };
      img.onerror = () => reject(new Error('bad image'));
      img.src = URL.createObjectURL(file);
    } else if (file.type.startsWith('video/')) {
      /* providers can't watch video: grab a representative frame instead */
      const v = document.createElement('video');
      v.muted = true; v.src = URL.createObjectURL(file);
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
      v.onseeked = () => {
        const a = downscaleToJpeg(v, v.videoWidth, v.videoHeight, file.name + ' (frame)');
        URL.revokeObjectURL(v.src);
        resolve(a);
      };
      v.onerror = () => reject(new Error('bad video'));
    } else if (file.type === 'application/pdf') {
      if (file.size > 15 * 1024 * 1024) return reject(new Error('PDF over 15MB'));
      const r = new FileReader();
      r.onload = () => resolve({ kind: 'pdf', name: file.name, mime: 'application/pdf', data: b64FromDataUrl(r.result) });
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    } else {
      file.text().then(t => resolve({ kind: 'text', name: file.name, text: t.slice(0, 20000) })).catch(reject);
    }
  });
}

function renderAttChips() {
  const row = $('attRow');
  row.innerHTML = '';
  pendingAtt.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    if (a.preview) { const im = document.createElement('img'); im.src = a.preview; chip.appendChild(im); }
    const s = document.createElement('span'); s.textContent = a.name || a.kind; chip.appendChild(s);
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove';
    x.addEventListener('click', () => { pendingAtt.splice(i, 1); renderAttChips(); });
    chip.appendChild(x);
    row.appendChild(chip);
  });
}

async function addFiles(files) {
  for (const f of files) {
    try { pendingAtt.push(await fileToAttachment(f)); }
    catch (e) { toast(f.name + ': ' + e.message); }
  }
  renderAttChips();
}

/* ---------------- think-gap fillers ---------------- */
function scheduleFiller() {
  cancelFiller();
  if (!$('fillerChk').checked || !fillers.length) return;
  fillerTimer = setTimeout(() => {
    if (state === S.THINK) playClip(fillers[Math.floor(Math.random() * fillers.length)], .5);
  }, 650 + Math.random() * 650);
}
function cancelFiller() { clearTimeout(fillerTimer); }

/* ---------------- interrupts ---------------- */
function annotateInterrupted(spoken) {
  spoken = (spoken || '').trim();
  const last = history[history.length - 1];
  if (last && last.role === 'assistant')
    last.content = (spoken || last.content) + ' [interrupted by the user]';
  else if (spoken)
    history.push({ role: 'assistant', content: spoken + ' [interrupted by the user]' });
}
/* hard override: stop audio, abort all server-side work, reset state */
function bargeIn() {
  turn++;                                          /* invalidates stale callbacks */
  cancelFiller();
  speakEndAt = Date.now();
  const wasBusy = busy || state === S.SPEAK;
  const spoken = player ? player.stop() : '';
  fetch('/api/interrupt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ before: turn }),
  }).catch(() => {});
  if (wasBusy) annotateInterrupted(spoken);
  capLyra.innerHTML = '';
  setState(call && call.running ? S.LISTEN : S.IDLE);
  busy = false;
}

/* ---------------- control events from the stream ---------------- */
function handleCtl(ev) {
  if (ev.kind === 'gesture') doGesture(ev.name);
  else if (ev.kind === 'affect') avatar.setAffect(ev.name);
  else if (ev.kind === 'remember') { toast('She’ll remember that ♥'); spawnFx('hearts'); }
  else if (ev.kind === 'scene') {
    if (turn === userSceneTurn) return;   /* you picked a scene mid-reply: yours wins */
    sceneMgr.apply(ev.name).then(ok => { if (ok) markScenePicker(ev.name); });
  }
  else if (ev.kind === 'avatar') swapAvatar(ev.name);
}

/* ---------------- orchestrator ---------------- */
async function handleUser(text, opts = {}) {
  text = String(text || '').trim(); if (!text || !avatar) return;
  const myTurn = ++turn;                 /* this turn now owns the conversation */
  if (busy) {
    const spoken = player ? player.stop() : '';
    cancelFiller();
    annotateInterrupted(spoken);
  }
  busy = true; curBubble = null;
  const atts = pendingAtt.splice(0);
  renderAttChips();
  if (!opts.hidden) { addLog('user', text + (atts.length ? '  📎' + atts.length : '')); showUserCaption(''); }
  const entry = { role: 'user', content: text };
  if (atts.length) entry.attachments = atts.map(a => ({ kind: a.kind, name: a.name, mime: a.mime, data: a.data, text: a.text }));
  history.push(entry);
  while (history.length > 30) history.shift();
  setState(S.THINK); avatar.nudgeMood('thinking', .45);
  scheduleFiller();

  player = new SegmentPlayer(avatar, {
    onSegStart: seg => {
      if (myTurn !== turn) return;
      cancelFiller();
      if (state !== S.SPEAK) setState(S.SPEAK);
      for (const m of (seg.mood || [])) avatar.nudgeMood(m.emotion, m.w * .8);
      noteLyraSpeech(seg.caption);   /* feeds the echo filter */
      startCaption(seg);
      lyraBubbleAppend(seg.caption);
    },
    onWord: () => captionWord(),
    onAllDone: () => {
      if (myTurn !== turn) return;
      speakEndAt = Date.now();
      setState(call && call.running ? S.LISTEN : S.IDLE);
      busy = false;
      captionFadeSoon();
    },
  });
  const myPlayer = player;

  try {
    let full = '';
    await streamChat({
      messages: history.slice(), turnId: myTurn,
      context: vision && vision.note ? '[seen through the camera: ' + vision.note + ']' : '',
      onEvent: ev => {
        if (myTurn !== turn) return;
        if (ev.type === 'seg') myPlayer.addSeg(ev);
        else if (ev.type === 'audio') myPlayer.addAudio(ev.i, ev);
        else if (ev.type === 'ctl') handleCtl(ev);
        else if (ev.type === 'done') {
          full = ev.full || '';
          if (full) { history.push({ role: 'assistant', content: full }); exchanges++; renderHearts(); }
          myPlayer.finish();
        }
        else if (ev.type === 'error') { toast('Brain error: ' + ev.message); myPlayer.finish(); }
      },
    });
    if (myTurn !== turn) return;
    myPlayer.finish();                    /* stream closed without done: let played segments wrap up */
    if (!myPlayer.started) { setState(call && call.running ? S.LISTEN : S.IDLE); busy = false; }
  } catch (err) {
    if (myTurn !== turn) return;
    cancelFiller();
    addLog('sys', 'Brain call failed (' + err.message + '). Is the server running and the .env configured?');
    setState(call && call.running ? S.LISTEN : S.IDLE);
    avatar.nudgeMood('sad', .6);
    busy = false;
  }
}

/* ---------------- scene & avatar pickers ---------------- */
function buildPicker(el, items, cur, onPick) {
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label || it.name;
    b.dataset.name = it.name;
    if (it.name === cur) b.classList.add('cur');
    b.addEventListener('click', () => { onPick(it); closePickers(); });
    el.appendChild(b);
  }
}
function markScenePicker(name) {
  document.querySelectorAll('#scenePicker button').forEach(b =>
    b.classList.toggle('cur', b.dataset.name === (sceneMgr.current && sceneMgr.current.name)));
}
function markAvatarPicker() {
  document.querySelectorAll('#avatarPicker button').forEach(b => {
    const a = avatars.find(x => x.name === b.dataset.name);
    b.classList.toggle('cur', !!a && a.url === currentAvatarUrl);
  });
}
function closePickers() {
  $('scenePicker').classList.remove('open');
  $('avatarPicker').classList.remove('open');
}

async function swapAvatar(name) {
  const n = String(name || '').toLowerCase().trim().replace(/\s+/g, '-');
  const a = avatars.find(x => x.name === n) || avatars.find(x => x.name.includes(n) || n.includes(x.name));
  if (!a || a.url === currentAvatarUrl) return;
  toast('She’s changing...');
  try {
    await avatar.swapModel(a.url);
    currentAvatarUrl = a.url;
    anim = new AnimController(avatar.vrm);
    const has = await anim.load();
    avatar.mocapActive = has;
    if (has) {
      if (state === S.SPEAK) anim.setBase('talk');
      else if (state === S.THINK) anim.setBase('think');
      else if (state === S.LISTEN) anim.setBase('listen');
      else anim.setBase(idleFlavor());
    }
    spawnFx('sparkle');
    markAvatarPicker();
  } catch (e) { toast('Body swap failed: ' + e.message); }
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    avatar = new Avatar($('cv3d'), $('stageInner'));
    avatar.viseme = () => lip.current();
    avatar.onFx = spawnFx;
    sceneMgr = new SceneManager(avatar);
    sceneMgr.onChange = () => markScenePicker();

    /* sensory loop: prosody in, instant reactions out */
    ears = new Ears(avatar, {
      onFx: spawnFx,
      isAvatarSpeaking: avatarTalking,
      onUserSpeaking: () => {
        if (call) call.noteUserSpeaking();
        /* predictive listening: react to the voice before STT/LLM see it */
        if (state === S.IDLE || state === S.LISTEN) {
          if (anim && anim.hasMocap) anim.setBase('listen');
          avatar.microLean(1.2);
        }
        if ($('bargeChk').checked && (busy || state === S.SPEAK)) bargeIn();
      },
      onUserStopped: () => { if (call) call.noteUserStopped(); },
      onBackchannel: () => !!(anim && state === S.LISTEN && anim.oneShot('acknowledge')),
      onError: msg => toast(msg),
    });

    /* vision: she sees you. Notes ride into chat turns; expression changes
       trigger subconscious reactions; face position steers her gaze. */
    vision = new VisionSense({
      onGaze: (nx, ny) => avatar.setUserGaze(nx, ny),
      onError: msg => {
        toast(msg);
        $('visionBtn').classList.remove('on');
        $('selfView').classList.remove('show');
        $('selfView').srcObject = null;
      },
      onVision: v => {
        if (v.proximity === 'close') avatar.microLean(1.6);
        if (v.expression === 'happy' && lastSeenExpression !== 'happy') avatar.nudgeMood('happy', .35);
        if (v.expression === 'surprised') avatar.nudgeMood('surprised', .3);
        if (v.expression === 'sad' && lastSeenExpression !== 'sad') {
          avatar.setAffect('devoted');            /* comfort before a word is said */
          avatar.nudgeMood('sad', .3);
        }
        /* the magic beat: she notices a real change and says something first */
        const changed = v.expression !== lastSeenExpression;
        lastSeenExpression = v.expression;
        if (changed && ['sad', 'tired', 'happy'].includes(v.expression) &&
            !busy && Date.now() - lastProactiveAt > 120000) {
          lastProactiveAt = Date.now();
          handleUser('(Through the camera you just noticed: ' + v.note + '. React briefly and naturally to what you see.)', { hidden: true });
        }
      },
    });

    call = new CallLoop({
      lang: () => $('micLang').value,
      onUtterance: t => {
        showUserCaption('');
        if (isHerEcho(t)) return;      /* her own voice bounced off the speakers */
        handleUser(t);
      },
      onInterim: t => showUserCaption(isHerEcho(t) ? '' : t),
      onState: on => {
        document.body.classList.toggle('incall', on);
        $('callBtn').classList.toggle('on', on);
        $('callBtn').title = on ? 'End call' : 'Start call';
        if (on) { if (state === S.IDLE) setState(S.LISTEN); }
        else { showUserCaption(''); if (state === S.LISTEN) setState(S.IDLE); }
      },
      onError: msg => toast(msg),
      isAvatarSpeaking: avatarTalking,
    });

    loadMsg.textContent = 'Finding her...';
    const [avRes, scInit, hlRes] = await Promise.allSettled([
      fetch('/api/avatars').then(r => r.json()),
      sceneMgr.init(),
      fetch('/api/health').then(r => r.json()),
    ]);
    if (hlRes.status === 'fulfilled' && hlRes.value.stt === 'deepgram') call.engine = 'deepgram';
    avatars = avRes.status === 'fulfilled' ? (avRes.value.avatars || []) : [];
    const first = avatars.find(a => a.name === 'lyra') || avatars[0];
    currentAvatarUrl = first ? first.url : '/models/lyra.vrm';

    loadMsg.textContent = 'Waking her up...';
    await avatar.load(currentAvatarUrl);

    loadMsg.textContent = 'Teaching her to move...';
    anim = new AnimController(avatar.vrm);
    const hasMocap = await anim.load(f => { loadMsg.textContent = 'Loaded ' + f; });
    avatar.mocapActive = hasMocap;
    if (hasMocap) anim.setBase('idle');
    else addLog('sys', 'No mocap clips found in public/animations/. Running on the procedural fallback; see the README for the Mixamo clip list.');

    buildPicker($('scenePicker'), sceneMgr.scenes, sceneMgr.current && sceneMgr.current.name,
      it => { userSceneTurn = turn; sceneMgr.apply(it.name).then(() => markScenePicker(it.name)); });
    buildPicker($('avatarPicker'), avatars, null, it => swapAvatar(it.name));
    markAvatarPicker();

    /* think-gap sounds: cached server-side, fetched lazily */
    fetch('/api/fillers').then(r => r.json()).then(j => { fillers = j.clips || []; }).catch(() => {});

    loadEl.style.display = 'none';
    renderHearts();
    setState(S.IDLE);
    /* console debug handle */
    window.lyra = { avatar, sceneMgr, get anim() { return anim; }, get state() { return state; } };

    const clock = { last: performance.now() };
    (function loop(now) {
      requestAnimationFrame(loop);
      const dt = Math.min(.05, (now - clock.last) / 1000); clock.last = now;
      sceneMgr.duck = state === S.SPEAK || (player && player.active);
      sceneMgr.update(dt);
      avatar.update(dt, d => { if (anim && anim.hasMocap) anim.update(d); });
    })(performance.now());

    /* she notices you arriving */
    handleUser('(Ori just came online and can see you now. Greet him.)', { hidden: true });
  } catch (e) {
    loadEl.style.display = 'flex';
    loadMsg.textContent = 'Startup failed: ' + e.message;
    console.error(e);
  }
}

/* ---------------- events ---------------- */
$('sceneSndChk').addEventListener('change', e => {
  sceneMgr.setSound(e.target.checked);
  toast(e.target.checked ? 'Scene ambience on' : 'Scene ambience off');
});
$('attBtn').addEventListener('click', () => $('attFile').click());
$('attFile').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
$('sendBtn').addEventListener('click', () => {
  const t = inp.value || (pendingAtt.length ? 'Take a look at this.' : '');
  inp.value = ''; handleUser(t);
});
inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const t = inp.value; inp.value = ''; handleUser(t); } });
$('stopBtn').addEventListener('click', () => { if (busy || state === S.SPEAK) bargeIn(); });

$('callBtn').addEventListener('click', async () => {
  if (call.running) {
    call.stop(); ears.stop();
    if (busy || state === S.SPEAK) bargeIn();
  } else {
    await ears.start();          /* VAD: predictive listening + endpointing (optional if denied) */
    call.start();
  }
});
$('muteBtn').addEventListener('click', () => {
  call.setMuted(!call.muted);
  $('muteBtn').classList.toggle('on', call.muted);
  toast(call.muted ? 'Mic muted' : 'Mic live');
});
setInterval(() => {
  if (call && call.running) {
    const s = Math.floor(call.elapsed);
    timerEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
}, 1000);

$('visionBtn').addEventListener('click', async () => {
  const sv = $('selfView');
  if (vision.running) {
    vision.stop();
    $('visionBtn').classList.remove('on');
    sv.classList.remove('show');
    sv.srcObject = null;
    toast('She can no longer see you');
  } else {
    if (await vision.start()) {
      $('visionBtn').classList.add('on');
      sv.srcObject = vision.stream;
      sv.play().catch(() => {});
      sv.classList.add('show');
      toast('She can see you now 👁');
    }
  }
});
$('selfView').addEventListener('click', () => $('selfView').classList.toggle('mini'));
$('camBtn').addEventListener('click', () => {
  camMode = camMode === 'full' ? 'close' : 'full';
  avatar && avatar.frame(camMode);
});
$('sceneBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('avatarPicker').classList.remove('open');
  $('scenePicker').classList.toggle('open');
});
$('avatarBtn').addEventListener('click', e => {
  e.stopPropagation();
  $('scenePicker').classList.remove('open');
  $('avatarPicker').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.picker') && !e.target.closest('#sceneBtn') && !e.target.closest('#avatarBtn')) closePickers();
});
$('chatBtn').addEventListener('click', () => $('drawer').classList.add('open'));
$('drawerClose').addEventListener('click', () => $('drawer').classList.remove('open'));

document.querySelectorAll('#exprRow button').forEach(b => {
  b.addEventListener('click', () => {
    if (!avatar) return;
    if (b.dataset.emo) {
      avatar.setEmotion(b.dataset.emo);
      pingAura();
      if (state === S.IDLE && anim && anim.hasMocap) anim.setBase(idleFlavor());
    }
    if (b.dataset.ges) doGesture(b.dataset.ges);
    if (b.dataset.aff) avatar.setAffect(b.dataset.aff);
  });
});

boot();
