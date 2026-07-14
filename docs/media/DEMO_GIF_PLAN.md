# Lyra × OpenClaw — Demo capture plan

For the ClawHub listing, the README hero, and social. The single most important
constraint: **GIFs are silent, and this product is voice** — so every clip must
make the value legible with no sound. Keep Lyra's word-synced **captions on**, and
pick prompts that trigger **visible** performance (a gesture, an expression shift,
a scene change). Lip-sync + captions + body motion carry it.

## The hero clip (README top + ClawHub card)

**~7 seconds, one unbroken take.**
1. (0–1s) Lyra idle, breathing. A short user line appears: *"guess what — I got the job!"*
2. (1–5s) She lights up — mouth lip-syncs, caption streams her reply, she **bounces**
   (this prompt reliably fires `[affect:teasing] [gasps] [gesture:bounce] [excited]`).
3. (5–7s) Settles with a warm smile. Loop-friendly end.

Shows all four differentiators at once: real-time reply, lip-sync, expression, gesture.

## Three supporting clips (~4–6s each)

- **"It's YOUR OpenClaw agent."** Quick cut: the OpenClaw Control UI / terminal
  showing the agent, then Lyra speaking that exact reply. Proves it's the agent,
  not a canned bot — this is the whole pitch, worth the extra effort. (Needs the
  live bridge.)
- **Distinct characters.** Same line — *"tell me about tonight"* — answered by
  **Nova** (playful, bright) then **Vesper** (elegant, composed). Cut between them.
- **She changes her world.** *"take me somewhere quiet and beautiful"* → she says
  a line and the scene crossfades (`[scene:cosmos]` / `night-city`) mid-sentence.

## Prompts that reliably trigger good tags

| Prompt | Shows |
|---|---|
| `guess what — I got the job!` | gasp + bounce + excited |
| `I'm a little nervous about tomorrow` | `[affect:focused]` soft, `[gesture:nod]`, tender |
| `take me somewhere beautiful` | `[scene:...]` change mid-line |
| `you're such a tease` | `[affect:teasing]` `[gesture:wink]` |

## Capture setup (Windows)

- **Tool:** ScreenToGif (free, purpose-built — record a region, edit frames,
  export optimized GIF) or OBS → record MP4, then convert.
- **Frame:** crop tight to the avatar + caption bar; fullscreen the call view to
  hide dev chrome; ~720p region.
- **Length:** 5–8s per clip. **fps:** 12–15 (GIF); higher for MP4.
- **Cursor:** hidden / out of frame.

## Two formats, two homes

- **GitHub README:** use **MP4** (drag-drop into the README on GitHub — autoplays,
  loops, sharper and smaller than GIF). Keep the existing screenshots too.
- **ClawHub card / X / Discord:** **GIF** (universal). Target **< 8 MB** — crop
  tighter, 12fps, trim to the essential seconds, 256-color palette.

### ffmpeg (MP4 → optimized GIF), if going that route

```bash
# 1) build a palette from the clip (crop/scale to taste)
ffmpeg -i clip.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
# 2) render the GIF using it
ffmpeg -i clip.mp4 -i palette.png -lavfi "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" out.gif
```

## Do / don't

- ✅ Captions **on**; start on an idle frame; end loop-friendly; one action per clip.
- ❌ No dead air — trim latency out in editing.
- ❌ Don't cram everything into one GIF; a set of short ones beats one long one.

## Prereqs

Gateway up (`openclaw doctor` / restart), the `clawlyra` skill installed (so she
emits the performance tags), and `LLM_PROVIDER=openclaw`. Until the bridge is live
you can pre-record the hero / character / scene clips on a **local brain**
(`LLM_PROVIDER=ollama`) — identical on camera; only the "it's your OpenClaw agent"
clip needs the live bridge.
