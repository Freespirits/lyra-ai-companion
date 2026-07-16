# Security Policy

Thanks for helping keep **Lyra** and the **clawlyra** skill safe for everyone who
self-hosts them.

## Supported versions

Lyra is developed on a rolling basis — security fixes land on the latest release
and on `main`. Please make sure you're on the newest version before reporting.

| Component            | Supported            |
| -------------------- | -------------------- |
| Lyra app — `main` / latest release | ✅ |
| clawlyra skill — latest on ClawHub  | ✅ |
| Older tagged versions               | ❌ (upgrade first)   |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **["Report a vulnerability"](https://github.com/Freespirits/lyra-ai-companion/security/advisories/new)**
button (Security → Advisories). This opens a private advisory only you and the
maintainer can see. (If that's disabled, enable *Private vulnerability reporting*
under repo Settings → Code security.)

When reporting, please include:

- What you found and where (file / endpoint / component).
- Steps to reproduce, or a proof-of-concept.
- The impact you think it has, and any suggested fix.

**Response targets** (best effort — this is an independent project):

- Acknowledgement within **72 hours**.
- An initial assessment within **7 days**.
- Coordinated disclosure once a fix is available. Reporters are credited unless
  you ask otherwise.

## Scope

In scope:

- The **Lyra app** (`server/`, `src/`, the operator/gateway bridge, TTS/STT
  integrations, the optional content guard).
- The **clawlyra skill** (`skills/clawlyra`).

Out of scope:

- Vulnerabilities in third-party dependencies or upstream services
  (Ollama, ElevenLabs, Deepgram, Edge TTS, OpenClaw, browser/WebGL). Report
  those upstream — we'll help coordinate if a version bump is the fix.
- Anything requiring physical access to a machine already running Lyra, or a
  self-inflicted misconfiguration of your own local instance.

## Handling secrets & tokens (operator guidance)

Lyra is **self-hosted and local-first** — you hold your own keys.

- All secrets live in **`.env`**, which is **gitignored and never committed**.
  Never paste your `.env`, `OPENCLAW_TOKEN`, `ELEVENLABS_API_KEY`, or
  `DEEPGRAM_API_KEY` into issues, discussions, logs, or screenshots.
- The gateway `OPENCLAW_TOKEN` grants operator access to your agent — treat it
  like a password. **Rotate it** in your OpenClaw config if it's ever exposed.
- Lyra binds to `localhost:8686` by default. If you expose it beyond your
  machine (reverse proxy, tunnel, LAN), put authentication in front of it — the
  local operator socket assumes a trusted host.

## Safety boundary (by design, not a bug)

Lyra's characters are **friends, never romantic** — that boundary is baked into
the personas and is always on, independent of your agent or any toggle. An
*optional* keyword content guard (`LYRA_GUARD=on`, off by default) adds a second
moderation pass. If you find a way to make a character cross that boundary, we
treat it as a safety issue — please report it privately using the process above.
