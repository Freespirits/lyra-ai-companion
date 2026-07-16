# Contributing to Lyra

Thanks for wanting to help. Lyra is a **self-hosted, local-first** avatar
companion — small, hackable, and meant to be run on your own machine.

## Ground rules

- **Be kind, keep it friendly.** The characters are friends, never romantic —
  that boundary is baked in and stays. PRs that weaken it won't be merged.
- **Local-first.** No telemetry, no phoning home, no required cloud accounts to
  run the core. Keep it that way.
- **Small and readable.** Match the surrounding style; prefer clear code over
  clever code.

## Getting set up

```bash
git clone https://github.com/Freespirits/lyra-ai-companion
cd lyra-ai-companion
npm install          # also fetches the avatar bodies and seeds .env
npm run dev          # backend :8686, app http://localhost:5173
npm test             # node --test
```

Requires Node 20+. Chrome or Edge for voice calls.

## Sending a change

1. Fork, branch off `main`.
2. Keep the PR focused — one thing at a time.
3. Run `npm test` and make sure the app still boots (`npm run dev`).
4. Describe what you changed and why, and how you tested it.

## Good first areas

- New scenes (`public/scenes/`), voices, or a character.
- STT/TTS providers, mobile (see `docs/MOBILE_PLAN.md`).
- Bug fixes with a clear repro.

## Security

Please **don't** open a public issue for security problems — see
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing you agree your work is licensed under the repo's
[PolyForm Noncommercial 1.0.0](LICENSE.md). The `clawlyra` skill is MIT-0.
