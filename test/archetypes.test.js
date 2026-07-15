import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHETYPES, GUARDRAILS, resolveArchetype, pickVoice } from '../server/archetypes.js';

test('there are six archetypes with body-matching ids', () => {
  assert.equal(ARCHETYPES.length, 6);
  assert.deepEqual(ARCHETYPES.map(a => a.id), ['lyra', 'nova', 'mira', 'vesper', 'kira', 'bao']);
});

test('every archetype is fully populated', () => {
  for (const a of ARCHETYPES) {
    for (const k of ['name', 'tagline', 'persona', 'scene', 'affect', 'greeting', 'intro', 'portrait']) {
      assert.ok(a[k] && String(a[k]).length, `${a.id} missing ${k}`);
    }
    assert.ok(Array.isArray(a.traits) && a.traits.length >= 2, `${a.id} traits`);
    assert.ok(a.voice.edge, `${a.id} edge voice`);
  }
});

test('guardrails forbid romance/flirtation/sex and harm, and use the name token', () => {
  assert.match(GUARDRAILS, /\{userName\}/);
  assert.match(GUARDRAILS, /never romantic/i);
  assert.match(GUARDRAILS, /never sexual/i);
  assert.match(GUARDRAILS, /harm|hurt/i);
});

test('no archetype persona or tagline carries romantic/sexual framing', () => {
  /* Both generations of the persona text that shipped. Assembled from parts so a
     history-scrubbing pass over the repo cannot silently delete this guard the
     way it deleted the personas it is here to catch. */
  const banned = new RegExp([
    'flirt', 'seduc', 'sultry', 'sensual', 'femme fatale', 'devoted flame',
    'intimate', 'possessive', 'constant heat', 'steady heat', 'make them feel it',
    'alluring', 'savou?r tension', 'burn the world down', 'adore (him|them)',
  ].join('|'), 'i');
  for (const a of ARCHETYPES) {
    assert.doesNotMatch(a.persona, banned, `${a.id} persona`);
    assert.doesNotMatch(a.tagline, banned, `${a.id} tagline`);
    assert.doesNotMatch(a.greeting, banned, `${a.id} greeting`);
  }
});

test('resolveArchetype falls back to the first archetype for unknown ids', () => {
  assert.equal(resolveArchetype('nova').id, 'nova');
  assert.equal(resolveArchetype('LYRA').id, 'lyra');
  assert.equal(resolveArchetype('').id, 'lyra');
  assert.equal(resolveArchetype('ghost').id, 'lyra');
});

test('resolveArchetype merges overrides shallowly, including voice', () => {
  const r = resolveArchetype('nova', { nova: { name: 'Nyx', voice: { edge: 'en-GB-LibbyNeural' } } });
  assert.equal(r.name, 'Nyx');
  assert.equal(r.voice.edge, 'en-GB-LibbyNeural');
  assert.equal(r.voice.elevenlabs, ARCHETYPES.find(a => a.id === 'nova').voice.elevenlabs);
});

test('pickVoice prefers the archetype voice, then env default', () => {
  const a = resolveArchetype('kira');
  assert.equal(pickVoice(a, 'edge'), a.voice.edge);
  const noEleven = { ...a, voice: { ...a.voice, elevenlabs: '' } };
  assert.equal(pickVoice(noEleven, 'elevenlabs', { elevenlabs: 'ENVID' }), 'ENVID');
});
