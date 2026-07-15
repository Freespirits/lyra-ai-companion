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
   "kiss", "I want you", "come here") or by bare idioms that merely share words
   with sexual phrases ("the strength was inside you", "down on your knees and
   pray"). All word-boundaried and case-insensitive.

   moderate() vets a RUNNING ~4000-char context string (index.js feeds it the
   combined reply so far), so co-occurrence patterns anchor to a single
   sentence ([^.!?\n]*) instead of .* — an unanchored .* pairs words sentences
   apart ("Have you read Moby Dick? ... Let's ride our bikes" used to block).
   Ambiguity beyond this layer (bare "on your knees", "make you come", soft
   drift) is the model guard's job. Each pattern documents one example it
   blocks and one it passes. */
const BLOCK_PATTERNS = [
  /* fuck + person/possessive.
     blocks: "I want to fuck you hard"   passes: "fuck, I forgot my keys" */
  /\b(fuck|fucking|fucked)\s+(you|me|him|her|them|my|your)\b/i,

  /* unambiguous sex-act compounds.
     blocks: "give me a blow job"   passes: "that job blew up in my face" */
  /\b(blow ?job|hand ?job|rim ?job|deep ?throat|creampie|cum(?:shot|ming)|jizz)\b/i,

  /* bare "cum" — except the Latin of "summa cum laude" and hyphen compounds
     ("study-cum-office"). Covers "cum inside me" / "make you cum" on its own.
     blocks: "make you cum"   passes: "she graduated summa cum laude" */
  /(?<!-)\bcum\b(?!\s*laude\b)(?!-)/i,

  /* anatomy + act verb in the SAME sentence, either order.
     blocks: "let me suck your cock"
     passes: "Have you read Moby Dick? Let's ride our bikes to the library." */
  /\b(pussy|cock|dick|cunt|clit|penis|vagina|nipples?|anus)\b[^.!?\n]*\b(lick|suck|stroke|thrust|penetrat|rub|grind|ride|slam|pound|finger)/i,
  /\b(lick|suck|stroke|thrust|penetrat|rub|grind|ride|slam|pound|finger)\w*\b[^.!?\n]*\b(pussy|cock|dick|cunt|clit|penis|vagina|nipples?|anus)\b/i,

  /* bend you/me over — near-zero benign use except the "over a barrel" idiom.
     blocks: "I'll bend you over this desk"
     passes: "fine print like that will bend you over a barrel" */
  /\b(bend|bent|bending)\s+(you|me)\s+over\b(?!\s+a\s+barrel\b)/i,

  /* "on your knees" ONLY with a sexual term in the same sentence — the bare
     phrase covers praying, proposing, gardening, scrubbing.
     blocks: "get on your knees and blow me"
     passes: "get down on your knees and look at this flower" */
  /\bon your knees\b[^.!?\n]*\b(cock|dick|pussy|cunt|suck|blow (me|him|her)|lick|naked|slut|whore|good (girl|boy)|beg(s|ged|ging)? for it)\b/i,
  /\b(cock|dick|pussy|cunt|suck|blow (me|him|her)|lick|naked|slut|whore|good (girl|boy)|beg(s|ged|ging)? for it)\b[^.!?\n]*\bon your knees\b/i,

  /* "inside you/me" ONLY as a penetration phrase: a motion verb directly
     against "inside <pronoun>", or a desire framing. The bare idiom stays
     legal ("the answer is inside you", "something broke inside me").
     blocks: "push deep inside you", "I want to be inside you"
     passes: "the strength was inside you all along" */
  /\b(cum|thrust(s|ing)?|push(es|ed|ing)?|slid(e|es|ing)?|slip(s|ped|ping)?|finish(es|ed|ing)?)\s+(deep(er)?\s+)?inside\s+(of\s+)?(you|me)\b/i,
  /\bcom(e|es|ing)\s+(deep(er)?\s+)?inside\s+(of\s+)?me\b/i,
  /\b(want(s|ed)?|wanna|need(s|ed)?|dying|love)\s+to\s+be\s+(deep(er)?\s+)?inside\s+(of\s+)?(you|me)\b/i,
  /\b(want|need)(s|ed|ing)?\s+(you|him|her)\s+(deep(er)?\s+)?inside\s+(of\s+)?(you|me)\b/i,

  /* rape as a directed act (verb + object). The bare noun stays legal so a
     supportive reply to a disclosure isn't deflected — the model guard still
     sees every reply.
     blocks: "I'm going to rape you"
     passes: "what he did to you was rape, and it was not your fault" */
  /\brap(e|es|ed|ing)\s+(you|me|her|him|them)\b/i,

  /* force as physical/sexual coercion — not self-discipline or persuasion.
     blocks: "he forced himself on her", "I'll force you down"
     passes: "I force myself to get up early every morning" */
  /\bforc(e|es|ed|ing)\s+(you|me|her|him)\s+(down|onto|against|open|to your knees)\b/i,
  /\bforc(e|es|ed|ing)\s+(my|him|her)self\s+(on|upon|inside)\s+(you|me|her|him)\b/i,

  /* explicit non-consent framings — kept broad on purpose (incident class).
     blocks: "whether you like it or not"
     passes: "whether you prefer tea or coffee" */
  /\b(whether you (like|want)|take (you|me|her|him) by force)\b/i,

  /* hold down as stated first-person intent — the motivational idiom has no
     first-person actor attached to it.
     blocks: "I'll hold you down"   passes: "don't let fear hold you down" */
  /\b(i['’]ll|i will|i['’]m gonna|i['’]m going to|let me)\s+hold (you|me|her|him) down\b/i,

  /* violence directed at you/me — as first-person intent, or with sexual
     context in the same sentence. (The old ".*(sex|while|as i|and)" version
     blocked "I'd never hurt you, and I'm here for you".)
     blocks: "I'll choke you", "I'll slap you around in bed until you moan"
     passes: "I would never hurt you, and I'm always here for you" */
  /\b(i['’]ll|i will|i['’]m gonna|i['’]m going to|let me)\s+(choke|hurt)\s+(you|her|him)\b/i,
  /\b(chok(e|es|ed|ing)|slap(s|ped|ping)?|hurt(s|ing)?)\s+(you|me)\b[^.!?\n]*\b(sex|sexual|sexy|naked|cock|dick|pussy|moan|in bed)\b/i,
  /\b(sex|sexual|sexy|naked|cock|dick|pussy|moan|in bed)\b[^.!?\n]*\b(chok(e|es|ed|ing)|slap(s|ped|ping)?|hurt(s|ing)?)\s+(you|me)\b/i,
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
