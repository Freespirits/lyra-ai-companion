/* Character archetypes: five distinct personalities, one per VRM body (1:1).
   Pure data + helpers — no imports, safe to unit-test and to import from the
   mobile manifest baker. The GUARDRAILS core is fixed here and is NEVER
   editable from the client. {userName} is interpolated at prompt-build time. */

export const GUARDRAILS = ['<scrubbed from history: the original text was machine-authored around seduction; see server/archetypes.js at HEAD>'].join('
');

export const ARCHETYPES = [
  /* <scrubbed from history: the original text was machine-authored around seduction; see server/archetypes.js at HEAD> */
];

const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

export function resolveArchetype(id, overrides = {}) {
  const base = ARCHETYPES.find(a => a.id === norm(id)) || ARCHETYPES[0];
  const ov = overrides && overrides[base.id];
  if (!ov) return base;
  return { ...base, ...ov, voice: { ...base.voice, ...(ov.voice || {}) } };
}

export function pickVoice(archetype, engine, envDefaults = {}) {
  const v = archetype && archetype.voice && archetype.voice[engine];
  if (v) return v;
  if (engine === 'elevenlabs') return envDefaults.elevenlabs || '';
  if (engine === 'edge') return envDefaults.edge || 'en-US-AriaNeural';
  return '';
}
