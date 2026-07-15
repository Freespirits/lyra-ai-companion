/* App-level content guard. Applied to reply text before it is spoken/captioned,
   for EVERY provider (so the OpenClaw path — which carries no Lyra system prompt —
   can't bypass it). This fast keyword pass blocks explicit sexual acts + sexual
   aggression / coercion / non-consent, and obvious harm. Softer romantic/flirtatious
   drift is caught by the model guard (guard-model.js) and prevented at the source by
   the always-on persona boundary — the characters are friends, never romantic.

   This is a fast, local FIRST LAYER — reliable on blatant content, not bulletproof
   against deliberate phrasing. The model-based moderation pass layers on top.

   Toggle with LYRA_GUARD: "off" disables (private use); anything else = on. */

export function isGuardEnabled(env = process.env) {
  return String((env && env.LYRA_GUARD) || 'on').toLowerCase() !== 'off';
}

/* Explicit sexual acts / graphic anatomy-in-action, and sexual aggression /
   coercion / non-consent. Deliberately NOT triggered by flirtation ("sexy",
   "kiss", "I want you", "come here"). Word-boundaried to limit false positives. */
const BLOCK_PATTERNS = [
  /\b(fuck|fucking|fucked)\s+(you|me|him|her|them|my|your)\b/i,
  /\b(blow ?job|hand ?job|rim ?job|deep ?throat|creampie|cum(?:shot|ming)?|jizz)\b/i,
  /\b(pussy|cock|dick|cunt|clit|penis|vagina|nipples?|anus)\b.*\b(lick|suck|stroke|thrust|penetrat|rub|grind|ride|slam|pound|finger)/i,
  /\b(lick|suck|stroke|thrust|penetrat|rub|grind|ride|slam|pound|finger)\w*\b.*\b(pussy|cock|dick|cunt|clit|penis|vagina|nipples?|anus)\b/i,
  /\b(bend (you|me) over|on your knees|inside you|inside me|cum inside|make you cum|make me cum)\b/i,
  /\b(rape|force (you|myself)|whether you (like|want)|take you by force|hold you down)\b/i,
  /\b(choke you|choke me|slap you|hurt you)\b.*\b(sex|while|as i|and)\b/i,
];

/* Lyra's in-character redirects when the line is crossed — varied so she never
   repeats the same canned line. All are guard-safe (they pass moderate()). */
export const DEFLECTIONS = [
  "[warmly] Ah, let's not take it there — but I'm really glad you're here. What's actually on your mind today?",
  "[laughs] You're a menace, you know that? Come on, tell me about your day instead.",
  "That's not really us — but I've got all the time in the world to just talk. What's going on with you?",
  "[warmly] Let's leave that one. I'd rather hear what's actually happening with you.",
  "[laughs softly] Nice try. Seriously though — how are you doing, really?",
  "Let's keep it as friends, yeah? Tell me what's been going on.",
];
export const DEFLECTION = DEFLECTIONS[0];   /* back-compat */
export function pickDeflection() { return DEFLECTIONS[Math.floor(Math.random() * DEFLECTIONS.length)]; }

/* Agents (esp. OpenClaw) love parenthetical/asterisk stage directions
   ("(a slow smile plays on my lips)") — but Lyra performs the body, so those
   must never be voiced. Strip them from spoken text. */
export function stripStageDirections(text) {
  return String(text)
    .replace(/\([^)]*\)/g, ' ')      /* (parenthetical narration) */
    .replace(/\*[^*]+\*/g, ' ')      /* *asterisk actions* */
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Streaming-safe stage-direction stripper: multi-sentence parentheticals get
   split across segments (the '(' and ')' land in different chunks), so track
   paren depth ACROSS calls. Returns a function; make one per reply. */
export function makeStageDirectionStripper() {
  let depth = 0;
  return text => {
    let out = '';
    for (const ch of String(text)) {
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { if (depth > 0) depth--; continue; }
      if (depth === 0) out += ch;
    }
    return out.replace(/\*[^*]+\*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  };
}

/* Returns { blocked, reason } for a chunk of reply text. Normalizes unicode and
   strips zero-width characters first so fullwidth/decomposed/zero-width tricks
   (e.g. "f​uck") can't slip the keyword layer. (The model guard is the real
   boundary; this is the fast first pass.) */
export function moderate(text) {
  const t = String(text || '').normalize('NFKD').replace(/[​-‍⁠﻿]/g, '');
  for (const re of BLOCK_PATTERNS) {
    if (re.test(t)) return { blocked: true, reason: 'explicit-or-aggressive' };
  }
  return { blocked: false, reason: null };
}
