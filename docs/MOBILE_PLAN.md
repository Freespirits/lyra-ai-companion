# Lyra Mobile — iOS & Android plan

Goal: the full companion call experience as a native app, with the user free to
plug in **any brain**: Claude, ChatGPT, Gemini, Ollama, or a local model — via
API key *or* their existing consumer subscription where legitimately possible.

Everything the web app already does ports with it (this list is the feature
parity checklist): hands-free call loop with VAD barge-in + transcript echo
filter, streaming tag protocol (audio tags, affects, 13 mocap gestures,
scene/avatar/remember directives), sentence-pipelined ElevenLabs v3 with exact
lip sync, 15 scenes (video on an aspect-true cinema segment with ducked
ambience audio, GLSL animated skies, 360° photos), 5 swappable bodies, typed
persistent memory with reflection + semantic recall, attachments, and the
**vision sense** (§3a).

## 1. Two-phase strategy

**Phase 1 — Capacitor wrap (2–4 weeks to stores).**
The existing web app already runs the entire experience in a browser. Wrap it
with Capacitor (WebView + native plugins): one codebase, both stores.
- Keep: three.js/VRM rendering, scene system, captions UI, segment player.
- Replace per-platform: Web Speech API (unreliable in WebViews) → native STT
  plugin or Deepgram/Whisper (see §3); background audio session handling;
  mic permission flows.
- The Node backend logic (protocol.js, providers, TTS pipeline) moves either
  to (a) a tiny cloud relay you host, or (b) on-device: the entire server is
  provider-fetch + parsing, portable to a Capacitor background service in JS.
  Recommendation: on-device — keys never leave the phone, no server costs.

**Phase 2 — Native rendering (production grade).**
If WebView GPU/perf disappoints on mid-range Androids: port rendering to
**Unity as a Library** (UniVRM + uLipSync) embedded in a React Native shell,
same control protocol over a local bridge. This is the architecture commercial
companion apps ship. Everything above the renderer (protocol, providers,
STT/TTS) is unchanged.

## 2. Brain: provider abstraction

One interface, five adapters (the web app's server/index.js already implements
this shape — port it):

```
interface Brain { stream(messages, signal): AsyncIterable<textDelta> }
```

| Provider | Auth options | Streaming | Vision | PDF | Notes |
|---|---|---|---|---|---|
| Anthropic API | API key | ✅ SSE | ✅ | ✅ | best long-form persona quality |
| Claude (subscription) | **Claude Agent SDK / OAuth** | ✅ | ✅ | ✅ | see §2a — the legit "no API key" path |
| OpenAI / ChatGPT | API key | ✅ SSE | ✅ | ✖ (convert) | gpt-4o etc. |
| Gemini | API key (free tier exists) | ✅ | ✅ | ✅ | generous free quota; native video input |
| Ollama (remote) | none — your own box | ✅ | model-dep. | ✖ | phone talks to your PC over LAN/Tailscale |

### 2a. Subscription auth ("web auth") — what's actually possible

- **Claude**: officially supported. The Claude Agent SDK authenticates with a
  claude.ai subscription login (OAuth) — no API key. On desktop this is what
  `LLM_PROVIDER=claude-code` already does in this repo (spawns `claude -p`).
  On mobile, embed the Agent SDK flow or route through your desktop relay.
- **Gemini**: Google account OAuth via the free-tier API key (AI Studio) is
  effectively "login, no billing". `gemini` CLI on desktop = same idea.
- **ChatGPT**: the Codex CLI signs in with a ChatGPT subscription
  (`LLM_PROVIDER=codex` in this repo, desktop only). There is **no supported
  mobile-embeddable equivalent**; scraping chat.openai.com session cookies
  violates OpenAI ToS and breaks constantly — not recommended, not planned.
- Pattern that makes all of this work on the phone with zero mobile auth code:
  **the desktop relay** — your PC runs this repo's server (which already holds
  every provider), the phone connects over Tailscale/WireGuard. The phone gets
  subscription-auth providers "for free" because the desktop CLIs do the auth.

## 3. Voice in, voice out

**STT (three tiers, user-selectable):**
1. **On-device Whisper** — private, offline, free:
   iOS: WhisperKit (CoreML, whisper-large-v3-turbo runs on A15+).
   Android: whisper.cpp via JNI (small/medium models, NNAPI accel).
   VAD: Silero VAD on-device for endpointing (~1MB model), same
   speech-onset → predictive-listening → 800ms-quiet → commit loop as the web app.
2. **Deepgram streaming** — best accuracy/latency balance; the `/stt` relay
   from this repo ports as-is (phone → relay → Deepgram) or direct with a
   short-lived token endpoint.
3. **OS dictation** (SFSpeechRecognizer / Android SpeechRecognizer) — free
   fallback, wired like the Web Speech engine.

**TTS:** ElevenLabs v3 with timestamps over the existing segment pipeline
(unchanged — it's plain HTTPS). Fallback: on-device (AVSpeechSynthesizer /
Android TTS) with the estimated-viseme path that already exists.

**Call UX specifics:** audio session config (playAndRecord + AEC voice
processing on iOS, AudioManager MODE_IN_COMMUNICATION on Android) gives
hardware echo cancellation — the speaker/mic echo gate gets easier than web.
Background mode: continue the call screen-off (audio background entitlement).

### 3a. Vision sense (she sees you)

The web app's pipeline ports directly and gets *better* on mobile:
- **Frame capture**: front camera → downscaled JPEG every ~5s → vision-capable
  brain (Claude / Gemini / GPT-4o / Ollama vision) → `{note, expression,
  proximity}`. The note rides into the next turn as
  `[seen through the camera: ...]`; expression changes trigger subconscious
  affect/mood shifts and occasional proactive lines (rate-limited).
- **Gaze tracking**: on mobile, replace the web's FaceDetector with **ARKit
  face tracking (iOS)** / **ML Kit Face Detection (Android)** — both free,
  on-device, 60fps, and far better than anything in the browser: real gaze
  following, plus expression blendshapes (ARKit gives smile/frown/jaw values
  directly — the "user is smiling" signal without any LLM call).
- Privacy: frames are analyzed and discarded, nothing persists; camera use is
  a visible toggle with the OS indicator. On-device expression detection
  (ARKit/ML Kit) can replace most LLM vision calls to cut cost and latency —
  send a frame to the big model only on meaningful change.

## 4. Attachments (+)

Same protocol as the web app (this repo, `normalizeAttachments`):
- Photos/camera: pick → downscale to ≤1400px JPEG → base64 in the message.
- Video: extract 1–3 frames on-device (AVAssetImageGenerator / MediaMetadataRetriever); Gemini adapter can take real video.
- PDF: pass through to Anthropic/Gemini; text-extract locally (PDFKit/pdfbox) for providers without document support.
- txt/md: inline, 20k cap.

## 5. App architecture

```
┌─ UI shell (RN or Capacitor) ─────────────────────────┐
│ Call screen: 3D view · captions · call bar · drawer  │
├─ Renderer: WebView three-vrm (P1) / Unity lib (P2)   │
├─ Session core (TS, ported from this repo):           │
│   protocol.js · segment player · turn/interrupt mgr  │
│   mood/affect state · scene manager                  │
├─ Brain adapters: anthropic | claude-sub | openai |   │
│   gemini | ollama-remote | desktop-relay             │
├─ Voice: whisper-on-device | deepgram | os-dictation  │
│          elevenlabs-v3 | os-tts                      │
└─ Storage: Keychain/Keystore (keys), SQLite (history),│
           file cache (scenes, VRMs, filler audio)     │
```

- Settings screen = provider picker + key entry (stored in secure enclave),
  voice picker, STT tier, scene/avatar management (download/import VRM).
- History sync (optional, later): end-to-end encrypted blob to iCloud/Drive.

## 6. Store realities

- Apple/Google will review a companion app with a flirty persona: keep an
  age gate (17+/Mature), a content-safety toggle, and no store-visible NSFW.
- Mic + background audio permissions need clear purpose strings.
- ElevenLabs/Deepgram costs: bring-your-own-key keeps you out of the payments
  business; otherwise you need IAP + your own metering.

## 7. Milestones

1. **M0 (1w):** Capacitor shell boots the existing web app on both platforms; mic permission + audio session sorted.
2. **M1 (2–3w):** native STT tier (OS dictation), on-device session core, provider settings screen. Ship internal beta.
3. **M2 (2w):** WhisperKit/whisper.cpp + Silero VAD; Deepgram tier; attachments.
4. **M3 (2w):** desktop-relay pairing (QR + Tailscale) → subscription providers on phone; polish, store submission.
5. **M3.5 (1w):** vision sense — camera toggle, ARKit/ML Kit gaze + expression,
   frame-to-brain pipeline with on-device change detection.
6. **M4 (later):** Unity renderer if WebView perf demands it; history sync.
