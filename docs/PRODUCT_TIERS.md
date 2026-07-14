# Lyra — Product Tiers (Strategy Note)

Date: 2026-07-14
Status: Strategy only — NOT a build spec. Captures the tier ladder so Tier-1
engineering decisions don't paint us into a corner. Tiers 2–3 get their own
brainstorm + spec later, only after Tier 1 has real users.

## The one architectural fact that makes tiering cheap

The app is already **tier-agnostic**. `src/config.js` has a server-address
layer (`localStorage 'lyra-server'`, built for the mobile app so a phone can
reach a server over the network). The *same* codebase runs:
- **locally** — client talks to a server on `localhost` (Electron / dev), or
- **remotely** — a thin client talks to a server on a VPS.

So we never fork the product for hosting. Hosted tiers = the same server behind
an accounts/billing layer. Keep this true: don't hardwire `localhost`, keep all
config flowing through the server-address + config layer.

## The ladder

| Tier | User gets | Runs on | Brain / Voice | Our cost | Status |
|---|---|---|---|---|---|
| **1 — Local / Free** | Install → pick model → works. Fully private. **OpenClaw avatar wedge lives here.** | User's PC (Electron) | Local (Ollama/Hermes) · own key · **their OpenClaw** / Edge voice | **~$0** | **Building now** (Specs 1 + 2) |
| **2 — Hosted / VPS** | No capable PC needed; always-on; phone access. Subscription. | Our VPS + thin client | Hybrid: managed default + BYO key | VPS + inference | **Deferred** — own spec later |
| **3 — Premium** | Tier 2 **+ ElevenLabs voices + full Character Builder** | Our VPS | ElevenLabs + editor | + ElevenLabs | **Deferred** |

Cost model for the paid tiers (decided): **Hybrid** — managed usage included up
to a fair-use cap, with a bring-your-own-key option for heavy users / cost
control. (Most billing complexity; best UX. Long-term target, not near-term.)

## Why Tier 1 first (not a compromise — the funnel)

- Costs us ~nothing; fully private; ships without app-store or payment gatekeepers.
- The **OpenClaw avatar** is the viral wedge: real demand, an unfilled gap, and
  Lyra's streaming + exact lip-sync is the differentiator incumbents lack.
- A large free local base is what *earns the right* to monetize later, and tells
  us what people actually pay for before we build billing for guesses.

## Hard truths to respect before building Tiers 2–3 (do NOT skip)

1. **Don't build managed billing before there are users.** Metering, quotas,
   Stripe, fraud/abuse, multi-tenant isolation is months of work. Premature.
2. **Hosted economics are thin.** Self-hosted local models need GPUs (expensive);
   ElevenLabs bills per character of speech (a chatty companion burns it fast).
   If managed, lean on API models (Anthropic/OpenAI) with hard usage caps, not
   self-hosted GPU. Unit economics are the hard part, not the code.
3. **Category / payments risk is real but manageable, and lives only at the paid
   tiers.** Position as a *companion*, never "romantic/girlfriend AI"; keep the
   no-explicit guardrail firm; pick a payment processor that accepts companion
   apps. This is the safe lane Character.AI / Sesame / Pi occupy. Replika is the
   cautionary tale (hit when it leaned into erotic roleplay + a privacy failure).
   Confirm a processor will take the app **before** investing in billing.
4. **Intimate data = real privacy obligation.** Memory/transcripts are sensitive;
   hosting them raises GDPR/retention/security duties a local app doesn't.

## Guardrails for Tier-1 decisions (so we don't corner ourselves)

- Keep server/client split clean; no `localhost` hardcoding (use the config layer).
- Keep per-user data (memory, config) in a relocatable store, not baked into paths.
- Keep the provider + voice layers modular (already true) so a hosted tier can
  swap in managed inference without touching the app.
- Keep the no-explicit guardrail in the fixed core (already true).
