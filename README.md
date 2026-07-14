# Lyra — the AI companion you call, not type at

Press call. She picks up: an emotional voice that laughs and whispers, a 3D
body that breathes, worlds that change around her mid-sentence, and a memory
of you that deepens every conversation. 100% local, 100% yours.

Under the hood: hands-free call mode with VAD barge-in, a streaming brain with
an inline tag protocol, ElevenLabs v3 emotional speech, generated video scenes,
live body swapping, mocap animation, a continuously simmering mood system, and
typed persistent memory with reflection.

```
Browser (Vite, three.js + three-vrm)             Node backend (Express)
  call loop: VAD endpointing + continuous STT -> /api/chat (NDJSON stream)
  <- seg / audio / ctl events (sentence-pipelined eleven_v3 with audio tags)
  ordered segment player -> visemes + word-synced captions
  ears WebSocket -> prosody cues (laugh/sigh/silence/user_speaking)
```

## Quick start

```bash
npm install
node scripts/fetch-assets.mjs   # downloads the avatar bodies (VRoid samples)
cp .env.example .env            # fill in your provider settings
npm run dev                     # backend on :8686, app on http://localhost:5173
```

Requires Node 20+. Chrome or Edge required for voice calls (Web Speech API).
Note: the backend port is 8686 because Windows reserves 8758-8857
(`netsh interface ipv4 show excludedportrange protocol=tcp`).

## The call

Press the phone button. From that moment the mic is always open:

- `ears.js` VAD detects your voice and triggers **predictive listening** (she
  leans in before the words are even transcribed).
- ~900ms of quiet commits the utterance to the brain. No buttons.
- Speaking while she talks **barges in**: all server-side work for the old turn
  is aborted, her history entry is rewritten to what she actually got to say.
- While she speaks, recognition results are only accepted if the VAD confirmed
  user speech (echo gate). Headphones make it perfect; speakers work.

## The control protocol (streamed tags)

The LLM streams plain prose with inline bracket tags — no JSON:

- **Audio tags** `[laughs] [whispers] [sighs] [excited] [curious] ...` stay in
  the TTS text (eleven_v3 performs them as vocal emotion) and nudge the avatar's
  mood vector at the same time. One tag drives voice and face together.
- **Directive tags** `[scene:cosmos] [avatar:kira] [gesture:wave]` are stripped
  before TTS and executed instantly — she can change the scene or her body
  mid-sentence.

The server splits the stream into sentences, synthesizes each segment
concurrently (order-preserving), and streams NDJSON events; she starts speaking
after the first sentence while the rest is still generating. Long replies are
the default.

The complete tag vocabulary and agent-facing contract is documented in
[docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md).

## Mood, eyes, physics (the "alive" layer)

- **Mood vector**: emotions are a weighted blend (`{devoted:.8, amused:.2}`)
  that tags nudge and time decays — never a binary switch. Expressions render
  the mix additively, so feelings visibly linger and leak.
- **Saccadic gaze**: instant micro-jumps with fixation jitter and occasional
  glances aside; asymmetric blinking (one lid leads).
- **Spring-bone tuning + head inertia**: hair and clothes carry weight and drag
  behind sharp head motion (`SPRING_TUNE` in src/avatar.js).
- **Subconscious micro-events**: fleeting half-smiles, brow flashes, deeper
  breaths, weight shifts — always running between turns.
- **Think-gap fillers**: pre-synthesized "Mmm…" / "Hm?" sounds (cached in
  server/.cache) mask LLM+TTS latency like a real person mulling it over.

## Scenes

`/api/scenes` merges built-in procedural skies (violet-dream, bedroom,
sunset-beach, night-city, cosmos) with anything you drop into `public/scenes/`:
any equirectangular `.jpg/.png/.webp` becomes a 360° scene automatically, with
optional lighting overrides in `public/scenes/scenes.json`:

```json
[{ "name": "my-room", "lighting": { "key": ["#ffd9b0", .34], "rim": ["#ff6b9d", .1], "amb": ["#c9a68a", .2] } }]
```

Scene switches crossfade and lerp the lighting, safe mid-speech. Both you (the
picker in the call bar) and Lyra (`[scene:name]`) control them.

## Avatars (bodies)

Every `.vrm` in `public/models/` is auto-discovered and becomes a body Lyra can
wear — same voice, same conversation. Swap from the picker or let her do it
with `[avatar:name]`. Build characters in VRoid Studio (free) and export VRM.

## Mocap clips

Download clips from Mixamo (free, Adobe account; export FBX Binary, Without
Skin, 30fps) into `public/animations/`. File names are matched
case-insensitively:

| File | Mixamo search | Used for |
|---|---|---|
| `idle.fbx` `idle2.fbx` `idle3.fbx` | Breathing/Standing Idle | idle rotation |
| `happy-idle.fbx` / `sad-idle.fbx` | Happy Idle / Sad Idle | mood idles |
| `listen.fbx` / `think.fbx` | Standing Idle / Thinking | listening / thinking |
| `talk.fbx` `talk2.fbx` | Talking | speaking |
| `wave.fbx` `excited.fbx` `agree.fbx` `shrug.fbx` | (same) | gestures |

Missing files are skipped; without any clips a procedural idle takes over.

## Providers (.env)

**LLM** (`LLM_PROVIDER`): `ollama` (local; `OLLAMA_MODEL`), `anthropic`
(`ANTHROPIC_API_KEY`), or the **subscription CLIs — no API key**:
`claude-code` (spawns `claude -p`, your Claude subscription), `codex`
(ChatGPT subscription), `gemini-cli` (Google account). All stream.

**STT**: set `DEEPGRAM_API_KEY` for Deepgram nova live streaming (server-side
relay on `/stt`, best accuracy + endpointing); without it, the free Web Speech
API is used. Whisper on-device is the mobile plan (docs/MOBILE_PLAN.md).

**Attachments**: the + button in the chat drawer takes images, video (a frame
is extracted), .txt/.md, and PDF. Anthropic reads images+PDFs natively; Ollama
gets images (vision models); text files inline everywhere.

**TTS** (`TTS_PROVIDER`):
- `elevenlabs` (recommended): `ELEVENLABS_MODEL=eleven_v3` performs the audio
  tags with real emotion, and `/with-timestamps` drives exact viseme lip sync.
- `edge`: free Microsoft neural voices (tags stripped, energy-based lip sync).
- `browser`: OS speechSynthesis fallback.

Note: the server loads `.env` with `override:true`, so a stale
`ELEVENLABS_API_KEY` in your Windows environment variables can't shadow it.

**Aura** (`AURA_PROVIDER`): `hue` / `ha` / `off` — room lighting follows her
state and mood (server/aura.js).

## Sensory feedback loop (ambient ears)

The mic stream is analyzed continuously (RMS + pitch, client-side) and compact
prosody frames feed the backend cue engine (`server/ears.js`): laughs make her
smile before you type a word, sighs get a concerned tilt, long silences a weight
shift; cues are also folded into the next LLM call as
`[heard through the mic: ...]` context.

## Where to take it next

1. **Local STT**: swap Web Speech for faster-whisper + VAD endpointing for
   sub-second, fully offline turn-taking.
2. **Real 360° photography** in public/scenes/ (the shipped skies are procedural).
3. **A voice per body**: map avatar names to ElevenLabs voice IDs.
